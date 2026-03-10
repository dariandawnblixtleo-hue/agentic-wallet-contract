import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, internal, SendMode, storeOutList, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import {
    addressHash,
    AgenticWallet,
    bufferToUint256,
    calculateWalletIndex,
    createAddExtensionExtraAction,
    createChangeNftContentBody,
    createChangeOperatorBody,
    createDeployWalletBody,
    createExternalSignedRequestBodyWithoutSignature,
    createInternalSignedRequestBodyWithoutSignature,
    createProveOwnershipBody,
    createRemoveExtensionExtraAction,
    createSetSignatureAllowedExtraAction,
    createSnakedExtraActions,
    parseOwnerInfo,
    parseOwnershipProof,
    parseOwnershipProofBounced,
    walletIndexSeedToCell,
    WalletRuntimeData,
} from '../wrappers/AgenticWallet';
import { buildOnchainMetadata, NftCollection } from '../wrappers/NftCollection';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

describe('AgenticWallet', () => {
    let walletCode: Cell;
    let collectionCode: Cell;

    beforeAll(async () => {
        walletCode = await compile('AgenticWallet');
        collectionCode = await compile('NftCollection');
    });

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let helperExtension: SandboxContract<TreasuryContract>;
    let nftCollection: SandboxContract<NftCollection>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        stranger = await blockchain.treasury('stranger');
        helperExtension = await blockchain.treasury('helper');

        nftCollection = blockchain.openContract(
            NftCollection.createFromConfig(
                {
                    adminAddress: owner.address,
                    content: buildOnchainMetadata({
                        name: 'Agentic Wallets',
                        description: 'Test collection',
                    }),
                    nftItemCode: walletCode,
                },
                collectionCode,
            ),
        );

        const deployResult = await nftCollection.sendDeploy(owner.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: nftCollection.address,
            deploy: true,
            success: true,
        });
    });

    function createRuntimeData(
        operatorKeys: { publicKey: Buffer },
        nftItemContent: Cell | null = null,
        deployedByUser = true,
    ): WalletRuntimeData {
        const publicKey = bufferToUint256(operatorKeys.publicKey);
        return {
            ownerAddress: owner.address,
            nftItemContent,
            originOperatorPublicKey: publicKey,
            operatorPublicKey: publicKey,
            deployedByUser,
        };
    }

    function openWalletByRuntimeData(runtimeData: WalletRuntimeData, nftItemIndex?: bigint) {
        const index =
            nftItemIndex ??
            calculateWalletIndex(runtimeData.ownerAddress, runtimeData.originOperatorPublicKey, runtimeData.deployedByUser ?? true);
        const wallet = blockchain.openContract(
            AgenticWallet.createFromConfig(
                {
                    nftItemIndex: index,
                    collectionAddress: nftCollection.address,
                },
                walletCode,
            ),
        );
        return { wallet, index };
    }

    async function deployWallet(
        wallet: SandboxContract<AgenticWallet>,
        sender: SandboxContract<TreasuryContract>,
        walletData: WalletRuntimeData,
        senderOriginOperatorPublicKey = 0n,
        queryId = 1n,
    ) {
        return wallet.sendDeployWallet(sender.getSender(), toNano('0.2'), {
            queryId,
            walletData,
            senderOriginOperatorPublicKey,
        });
    }

    function createSignedExternalRequest(params: {
        walletNftIndex: bigint;
        validUntil: number;
        seqno: number;
        outActions?: Cell | null;
        extraActions?: Cell | null;
        secretKey: Buffer;
    }) {
        const signable = createExternalSignedRequestBodyWithoutSignature({
            walletNftIndex: params.walletNftIndex,
            validUntil: params.validUntil,
            seqno: params.seqno,
            outActions: params.outActions ?? null,
            extraActions: params.extraActions ?? null,
        });
        return {
            walletNftIndex: params.walletNftIndex,
            validUntil: params.validUntil,
            seqno: params.seqno,
            outActions: params.outActions ?? null,
            extraActions: params.extraActions ?? null,
            signature: sign(signable.hash(), params.secretKey),
        };
    }

    it('serializes wallet helpers consistently', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 10));
        const runtimeData = createRuntimeData(operatorKeys, beginCell().storeStringTail('item-777.json').endCell());
        const expectedIndex = BigInt(`0x${walletIndexSeedToCell({
            ownerAddress: owner.address,
            originOperatorPublicKey: runtimeData.originOperatorPublicKey,
            deployedByUser: runtimeData.deployedByUser ?? true,
        }).hash().toString('hex')}`);

        expect(calculateWalletIndex(owner.address, runtimeData.originOperatorPublicKey, runtimeData.deployedByUser ?? true)).toBe(
            expectedIndex,
        );

        const initCell = beginCell()
            .storeAddress(owner.address)
            .storeMaybeRef(runtimeData.nftItemContent)
            .storeUint(runtimeData.originOperatorPublicKey, 256)
            .storeUint(runtimeData.operatorPublicKey, 256)
            .storeBit(runtimeData.deployedByUser ?? true)
            .endCell();
        expect(createDeployWalletBody({ queryId: 55n, walletData: runtimeData }).equals(
            beginCell()
                .storeUint(0x0609e47b, 32)
                .storeUint(55n, 64)
                .storeRef(initCell)
                .storeUint(0n, 256)
                .endCell(),
        )).toBe(true);

        const snake = createSnakedExtraActions([
            createAddExtensionExtraAction(helperExtension.address),
            createSetSignatureAllowedExtraAction(false),
        ]);
        const expectedSnake = beginCell()
            .storeSlice(createAddExtensionExtraAction(helperExtension.address).beginParse())
            .storeRef(beginCell().storeSlice(createSetSignatureAllowedExtraAction(false).beginParse()).endCell())
            .endCell();
        expect(snake.equals(expectedSnake)).toBe(true);
    });

    it('owner direct deploy initializes wallet with wallet-v5 getters', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 1));
        const runtimeData = createRuntimeData(operatorKeys, beginCell().storeStringTail('wallet-1.json').endCell());
        const { wallet, index } = openWalletByRuntimeData(runtimeData);

        const deployResult = await deployWallet(wallet, owner, runtimeData);

        expect(deployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            deploy: true,
            success: true,
        });
        expect(await wallet.getSeqno()).toBe(0);
        expect(await wallet.getPublicKey()).toBe(runtimeData.operatorPublicKey);
        expect(await wallet.getOriginPublicKey()).toBe(runtimeData.originOperatorPublicKey);
        expect(await wallet.getIsSignatureAllowed()).toBe(true);

        const extensions = await wallet.getExtensions();
        expect(extensions.size).toBe(0);

        const nftData = await wallet.getNftData();
        expect(nftData.isInitialized).toBe(true);
        expect(nftData.nftItemIndex).toBe(index);
        expect(nftData.collectionAddress.equals(nftCollection.address)).toBe(true);
        expect(nftData.ownerAddress?.equals(owner.address)).toBe(true);
        expect(nftData.nftItemContent?.equals(runtimeData.nftItemContent!)).toBe(true);
    });

    it('rejects owner-flow deploy from wrong sender and keeps wallet logically uninitialized', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 2));
        const runtimeData = createRuntimeData(operatorKeys);
        const { wallet } = openWalletByRuntimeData(runtimeData);

        const result = await deployWallet(wallet, stranger, runtimeData);
        expect(result.transactions).toHaveTransaction({
            from: stranger.address,
            to: wallet.address,
            exitCode: 50,
            success: false,
        });

        const nftData = await wallet.getNftData();
        expect(nftData.isInitialized).toBe(false);
    });

    it('rejects direct owner deploy when runtime data is marked as non-user deployment', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 19));
        const runtimeData = createRuntimeData(operatorKeys, null, false);
        const { wallet } = openWalletByRuntimeData(runtimeData);

        const result = await deployWallet(wallet, owner, runtimeData);
        expect(result.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            exitCode: 50,
            success: false,
        });

        expect((await wallet.getNftData()).isInitialized).toBe(false);
    });

    it('rejects deploy with mismatched wallet index and keeps wallet logically uninitialized', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 3));
        const runtimeData = createRuntimeData(operatorKeys);
        const wrongIndex = calculateWalletIndex(owner.address, bufferToUint256(keyPairFromSeed(Buffer.alloc(32, 4)).publicKey), true);
        const { wallet } = openWalletByRuntimeData(runtimeData, wrongIndex);

        const result = await deployWallet(wallet, owner, runtimeData);
        expect(result.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            exitCode: 149,
            success: false,
        });

        const nftData = await wallet.getNftData();
        expect(nftData.isInitialized).toBe(false);
    });

    it('rejects deploy when current operator key differs from origin operator key', async () => {
        const originKeys = keyPairFromSeed(Buffer.alloc(32, 16));
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 17));
        const runtimeData: WalletRuntimeData = {
            ownerAddress: owner.address,
            nftItemContent: null,
            originOperatorPublicKey: bufferToUint256(originKeys.publicKey),
            operatorPublicKey: bufferToUint256(operatorKeys.publicKey),
            deployedByUser: true,
        };
        const { wallet } = openWalletByRuntimeData(runtimeData);

        const result = await deployWallet(wallet, owner, runtimeData);
        expect(result.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            exitCode: 151,
            success: false,
        });

        expect((await wallet.getNftData()).isInitialized).toBe(false);
    });

    it('deploys a second wallet from an existing wallet using direct wallet-to-wallet flow', async () => {
        const operatorA = keyPairFromSeed(Buffer.alloc(32, 5));
        const operatorB = keyPairFromSeed(Buffer.alloc(32, 6));
        const walletAData = createRuntimeData(operatorA);
        const walletBData = createRuntimeData(operatorB, null, false);

        const { wallet: walletA, index: walletAIndex } = openWalletByRuntimeData(walletAData);
        const { wallet: walletB, index: walletBIndex } = openWalletByRuntimeData(walletBData);
        await deployWallet(walletA, owner, walletAData);

        const deployBody = createDeployWalletBody({
            queryId: 7n,
            walletData: walletBData,
            senderOriginOperatorPublicKey: walletAData.originOperatorPublicKey,
        });
        const outActions = beginCell()
            .store(
                storeOutList([
                    {
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                        outMsg: internal({
                            to: walletB.address,
                            value: toNano('0.05'),
                            bounce: true,
                            init: walletB.init!,
                            body: deployBody,
                        }),
                    },
                ]),
            )
            .endCell();
        const validUntil = Math.floor(Date.now() / 1000) + 3600;

        const request = createSignedExternalRequest({
            walletNftIndex: walletAIndex,
            validUntil,
            seqno: 0,
            outActions,
            secretKey: operatorA.secretKey,
        });
        const result = await walletA.sendExternalSignedRequest(request);

        expect(result.transactions).toHaveTransaction({
            to: walletB.address,
            deploy: true,
            success: true,
        });
        expect((await walletB.getNftData()).nftItemIndex).toBe(walletBIndex);
        expect(await walletB.getPublicKey()).toBe(walletBData.operatorPublicKey);
        expect(await walletB.getOriginPublicKey()).toBe(walletBData.originOperatorPublicKey);
    });

    it('rejects wallet-to-wallet deploy when sender origin proof is wrong', async () => {
        const operatorA = keyPairFromSeed(Buffer.alloc(32, 7));
        const operatorB = keyPairFromSeed(Buffer.alloc(32, 8));
        const walletAData = createRuntimeData(operatorA);
        const walletBData = createRuntimeData(operatorB, null, false);

        const { wallet: walletA, index: walletAIndex } = openWalletByRuntimeData(walletAData);
        const { wallet: walletB } = openWalletByRuntimeData(walletBData);
        await deployWallet(walletA, owner, walletAData);

        const deployBody = createDeployWalletBody({
            queryId: 8n,
            walletData: walletBData,
            senderOriginOperatorPublicKey: bufferToUint256(keyPairFromSeed(Buffer.alloc(32, 9)).publicKey),
        });
        const outActions = beginCell()
            .store(
                storeOutList([
                    {
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                        outMsg: internal({
                            to: walletB.address,
                            value: toNano('0.05'),
                            bounce: true,
                            init: walletB.init!,
                            body: deployBody,
                        }),
                    },
                ]),
            )
            .endCell();
        const validUntil = Math.floor(Date.now() / 1000) + 3600;

        const request = createSignedExternalRequest({
            walletNftIndex: walletAIndex,
            validUntil,
            seqno: 0,
            outActions,
            secretKey: operatorA.secretKey,
        });
        await walletA.sendExternalSignedRequest(request);

        const nftData = await walletB.getNftData();
        expect(nftData.isInitialized).toBe(false);
    });

    it('rejects wallet-to-wallet deploy when deployer wallet is not user-root', async () => {
        const operatorA = keyPairFromSeed(Buffer.alloc(32, 20));
        const operatorB = keyPairFromSeed(Buffer.alloc(32, 21));
        const operatorC = keyPairFromSeed(Buffer.alloc(32, 22));
        const walletAData = createRuntimeData(operatorA);
        const walletBData = createRuntimeData(operatorB, null, false);
        const walletCData = createRuntimeData(operatorC, null, false);

        const { wallet: walletA, index: walletAIndex } = openWalletByRuntimeData(walletAData);
        const { wallet: walletB, index: walletBIndex } = openWalletByRuntimeData(walletBData);
        const { wallet: walletC } = openWalletByRuntimeData(walletCData);
        await deployWallet(walletA, owner, walletAData);

        const deployBBody = createDeployWalletBody({
            queryId: 9n,
            walletData: walletBData,
            senderOriginOperatorPublicKey: walletAData.originOperatorPublicKey,
        });
        const outActionsToB = beginCell()
            .store(
                storeOutList([
                    {
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                        outMsg: internal({
                            to: walletB.address,
                            value: toNano('0.05'),
                            bounce: true,
                            init: walletB.init!,
                            body: deployBBody,
                        }),
                    },
                ]),
            )
            .endCell();
        const validUntil = Math.floor(Date.now() / 1000) + 3600;
        const reqA = createSignedExternalRequest({
            walletNftIndex: walletAIndex,
            validUntil,
            seqno: 0,
            outActions: outActionsToB,
            secretKey: operatorA.secretKey,
        });
        const deployBResult = await walletA.sendExternalSignedRequest(reqA);
        expect(deployBResult.transactions).toHaveTransaction({
            to: walletB.address,
            deploy: true,
            success: true,
        });
        expect((await walletB.getNftData()).nftItemIndex).toBe(walletBIndex);

        const deployCBody = createDeployWalletBody({
            queryId: 10n,
            walletData: walletCData,
            senderOriginOperatorPublicKey: walletBData.originOperatorPublicKey,
        });
        const outActionsToC = beginCell()
            .store(
                storeOutList([
                    {
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
                        outMsg: internal({
                            to: walletC.address,
                            value: toNano('0.01'),
                            bounce: true,
                            init: walletC.init!,
                            body: deployCBody,
                        }),
                    },
                ]),
            )
            .endCell();
        const reqB = createSignedExternalRequest({
            walletNftIndex: walletBIndex,
            validUntil,
            seqno: 0,
            outActions: outActionsToC,
            secretKey: operatorB.secretKey,
        });
        const deployCResult = await walletB.sendExternalSignedRequest(reqB);
        expect(deployCResult.transactions).toHaveTransaction({
            from: walletB.address,
            to: walletC.address,
            exitCode: 50,
            success: false,
        });

        expect((await walletC.getNftData()).isInitialized).toBe(false);
    });

    it('supports wallet-v5 external request validation and signature mode toggling', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 11));
        const runtimeData = createRuntimeData(operatorKeys);
        const { wallet, index } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const validUntil = Math.floor(Date.now() / 1000) + 3600;
        const ok = createSignedExternalRequest({
            walletNftIndex: index,
            validUntil,
            seqno: 0,
            secretKey: operatorKeys.secretKey,
        });
        const okResult = await wallet.sendExternalSignedRequest(ok);
        expect(okResult.transactions).toHaveTransaction({
            on: wallet.address,
            success: true,
        });
        expect(await wallet.getSeqno()).toBe(1);

        await expect(
            wallet.sendExternalSignedRequest(
                createSignedExternalRequest({
                    walletNftIndex: index,
                    validUntil,
                    seqno: 0,
                    secretKey: operatorKeys.secretKey,
                }),
            ),
        ).rejects.toThrow('Exit code: 133');

        await expect(
            wallet.sendExternalSignedRequest(
                createSignedExternalRequest({
                    walletNftIndex: index + 1n,
                    validUntil,
                    seqno: 1,
                    secretKey: operatorKeys.secretKey,
                }),
            ),
        ).rejects.toThrow('Exit code: 134');

        await expect(
            wallet.sendExternalSignedRequest(
                createSignedExternalRequest({
                    walletNftIndex: index,
                    validUntil: validUntil - 7200,
                    seqno: 1,
                    secretKey: operatorKeys.secretKey,
                }),
            ),
        ).rejects.toThrow('Exit code: 136');

        const disableWithoutExtensions = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 9n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createSetSignatureAllowedExtraAction(false)]),
        });
        expect(disableWithoutExtensions.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            exitCode: 142,
            success: false,
        });

        const addExtension = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 10n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createAddExtensionExtraAction(helperExtension.address)]),
        });
        expect(addExtension.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });

        const disableSignature = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 11n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createSetSignatureAllowedExtraAction(false)]),
        });
        expect(disableSignature.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });
        expect(await wallet.getIsSignatureAllowed()).toBe(false);

        await expect(
            wallet.sendExternalSignedRequest(
                createSignedExternalRequest({
                    walletNftIndex: index,
                    validUntil,
                    seqno: 1,
                    secretKey: operatorKeys.secretKey,
                }),
            ),
        ).rejects.toThrow('Exit code: 132');
    });

    it('lets owner manage extensions without storing owner in extensions', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 12));
        const runtimeData = createRuntimeData(operatorKeys);
        const { wallet } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const addExtension = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 10n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createAddExtensionExtraAction(helperExtension.address)]),
        });
        expect(addExtension.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });

        let extensions = await wallet.getExtensions();
        expect(extensions.get(addressHash(owner.address))).toBeUndefined();
        expect(extensions.get(addressHash(helperExtension.address))).toBe(true);

        const disableSignature = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 11n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createSetSignatureAllowedExtraAction(false)]),
        });
        expect(disableSignature.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });

        const removeHelperWhileDisabled = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 12n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createRemoveExtensionExtraAction(helperExtension.address)]),
        });
        expect(removeHelperWhileDisabled.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            exitCode: 144,
            success: false,
        });

        const enableSignature = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 13n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createSetSignatureAllowedExtraAction(true)]),
        });
        expect(enableSignature.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });

        const removeHelper = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 14n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createRemoveExtensionExtraAction(helperExtension.address)]),
        });
        expect(removeHelper.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });

        extensions = await wallet.getExtensions();
        expect(extensions.get(addressHash(helperExtension.address))).toBeUndefined();
        expect(extensions.get(addressHash(owner.address))).toBeUndefined();

        const removeOwner = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 15n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createRemoveExtensionExtraAction(owner.address)]),
        });
        expect(removeOwner.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            exitCode: 140,
            success: false,
        });
    });

    it('allows only owner to change operator and keeps origin operator stable', async () => {
        const oldOperator = keyPairFromSeed(Buffer.alloc(32, 13));
        const newOperator = keyPairFromSeed(Buffer.alloc(32, 14));
        const runtimeData = createRuntimeData(oldOperator);
        const { wallet, index } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const forbidden = await wallet.sendChangeOperator(
            stranger.getSender(),
            toNano('0.05'),
            14n,
            bufferToUint256(newOperator.publicKey),
        );
        expect(forbidden.transactions).toHaveTransaction({
            from: stranger.address,
            to: wallet.address,
            exitCode: 50,
            success: false,
        });

        const changed = await wallet.sendChangeOperator(
            owner.getSender(),
            toNano('0.05'),
            15n,
            bufferToUint256(newOperator.publicKey),
        );
        expect(changed.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });
        expect(await wallet.getPublicKey()).toBe(bufferToUint256(newOperator.publicKey));
        expect(await wallet.getOriginPublicKey()).toBe(runtimeData.originOperatorPublicKey);

        const validUntil = Math.floor(Date.now() / 1000) + 3600;
        await expect(
            wallet.sendExternalSignedRequest(
                createSignedExternalRequest({
                    walletNftIndex: index,
                    validUntil,
                    seqno: 0,
                    secretKey: oldOperator.secretKey,
                }),
            ),
        ).rejects.toThrow('Exit code: 135');

        const ok = await wallet.sendExternalSignedRequest(
            createSignedExternalRequest({
                walletNftIndex: index,
                validUntil,
                seqno: 0,
                secretKey: newOperator.secretKey,
            }),
        );
        expect(ok.transactions).toHaveTransaction({
            on: wallet.address,
            success: true,
        });
    });

    it('allows only owner to change nft item content', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 18));
        const initialContent = beginCell().storeStringTail('wallet-before.json').endCell();
        const updatedContent = beginCell().storeStringTail('wallet-after.json').endCell();
        const runtimeData = createRuntimeData(operatorKeys, initialContent);
        const { wallet } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        expect(createChangeNftContentBody(17n, updatedContent).equals(
            beginCell().storeUint(0x1a0b9d51, 32).storeUint(17n, 64).storeMaybeRef(updatedContent).endCell(),
        )).toBe(true);

        const forbidden = await wallet.sendChangeNftContent(
            stranger.getSender(),
            toNano('0.05'),
            18n,
            updatedContent,
        );
        expect(forbidden.transactions).toHaveTransaction({
            from: stranger.address,
            to: wallet.address,
            exitCode: 50,
            success: false,
        });
        expect((await wallet.getNftData()).nftItemContent?.equals(initialContent)).toBe(true);

        const changed = await wallet.sendChangeNftContent(
            owner.getSender(),
            toNano('0.05'),
            19n,
            updatedContent,
        );
        expect(changed.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });
        expect((await wallet.getNftData()).nftItemContent?.equals(updatedContent)).toBe(true);
    });

    it('deactivates the agent by setting operator key to zero while owner extension keeps working', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 15));
        const runtimeData = createRuntimeData(operatorKeys);
        const { wallet, index } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        await wallet.sendChangeOperator(owner.getSender(), toNano('0.05'), 16n, 0n);
        expect(await wallet.getPublicKey()).toBe(0n);

        const validUntil = Math.floor(Date.now() / 1000) + 3600;
        await expect(
            wallet.sendExternalSignedRequest(
                createSignedExternalRequest({
                    walletNftIndex: index,
                    validUntil,
                    seqno: 0,
                    secretKey: operatorKeys.secretKey,
                }),
            ),
        ).rejects.toThrow('Exit code: 135');

        const internalSignedSignable = createInternalSignedRequestBodyWithoutSignature({
            walletNftIndex: index,
            validUntil,
            seqno: 0,
            outActions: null,
            extraActions: null,
        });
        await wallet.sendInternalSignedRequest(stranger.getSender(), toNano('0.05'), {
            walletNftIndex: index,
            validUntil,
            seqno: 0,
            outActions: null,
            extraActions: null,
            signature: sign(internalSignedSignable.hash(), operatorKeys.secretKey),
        });
        expect(await wallet.getSeqno()).toBe(0);

        const ownerAction = await wallet.sendExtensionActionRequest(owner.getSender(), toNano('0.05'), {
            queryId: 17n,
            hasExtraActions: true,
            extraActions: createSnakedExtraActions([createAddExtensionExtraAction(helperExtension.address)]),
        });
        expect(ownerAction.transactions).toHaveTransaction({
            from: owner.address,
            to: wallet.address,
            success: true,
        });

        const extensions = await wallet.getExtensions();
        expect(extensions.get(addressHash(helperExtension.address))).toBe(true);
    });

    // --- TEP-85 SBT: prove_ownership ---

    it('prove_ownership sends ownership_proof with content to dest', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 30));
        const nftContent = beginCell().storeStringTail('sbt-item.json').endCell();
        const runtimeData = createRuntimeData(operatorKeys, nftContent);
        const { wallet, index } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const forwardPayload = beginCell().storeStringTail('proof-data').endCell();
        const result = await wallet.sendProveOwnership(owner.getSender(), toNano('0.1'), {
            queryId: 42n,
            dest: stranger.address,
            forwardPayload,
            withContent: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: stranger.address,
            success: true,
        });

        const proofTx = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(wallet.address) &&
                tx.inMessage.info.dest.equals(stranger.address),
        );
        const proof = parseOwnershipProof(proofTx!.inMessage!.body);
        expect(proof.queryId).toBe(42n);
        expect(proof.itemId).toBe(index);
        expect(proof.owner.equals(owner.address)).toBe(true);
        expect(proof.data.equals(forwardPayload)).toBe(true);
        expect(proof.revokedAt).toBe(0n);
        expect(proof.content).not.toBeNull();
        expect(proof.content!.equals(nftContent)).toBe(true);
    });

    it('prove_ownership omits content when withContent is false', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 31));
        const nftContent = beginCell().storeStringTail('sbt-item.json').endCell();
        const runtimeData = createRuntimeData(operatorKeys, nftContent);
        const { wallet } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const forwardPayload = beginCell().storeStringTail('no-content-proof').endCell();
        const result = await wallet.sendProveOwnership(owner.getSender(), toNano('0.1'), {
            queryId: 43n,
            dest: stranger.address,
            forwardPayload,
            withContent: false,
        });

        const proofTx = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(wallet.address) &&
                tx.inMessage.info.dest.equals(stranger.address),
        );
        const proof = parseOwnershipProof(proofTx!.inMessage!.body);
        expect(proof.queryId).toBe(43n);
        expect(proof.content).toBeNull();
    });

    it('prove_ownership rejects non-owner sender', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 32));
        const runtimeData = createRuntimeData(operatorKeys);
        const { wallet } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const result = await wallet.sendProveOwnership(stranger.getSender(), toNano('0.1'), {
            queryId: 44n,
            dest: stranger.address,
            forwardPayload: beginCell().endCell(),
            withContent: false,
        });
        expect(result.transactions).toHaveTransaction({
            from: stranger.address,
            to: wallet.address,
            exitCode: 50,
            success: false,
        });
    });

    // --- TEP-85 SBT: request_owner ---

    it('request_owner sends owner_info to dest (callable by anyone)', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 33));
        const nftContent = beginCell().storeStringTail('sbt-owner-info.json').endCell();
        const runtimeData = createRuntimeData(operatorKeys, nftContent);
        const { wallet, index } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const forwardPayload = beginCell().storeStringTail('request-data').endCell();
        const result = await wallet.sendRequestOwner(stranger.getSender(), toNano('0.1'), {
            queryId: 50n,
            dest: helperExtension.address,
            forwardPayload,
            withContent: true,
        });

        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: helperExtension.address,
            success: true,
        });

        const infoTx = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(wallet.address) &&
                tx.inMessage.info.dest.equals(helperExtension.address),
        );
        const info = parseOwnerInfo(infoTx!.inMessage!.body);
        expect(info.queryId).toBe(50n);
        expect(info.itemId).toBe(index);
        expect(info.initiator.equals(stranger.address)).toBe(true);
        expect(info.owner.equals(owner.address)).toBe(true);
        expect(info.data.equals(forwardPayload)).toBe(true);
        expect(info.revokedAt).toBe(0n);
        expect(info.content).not.toBeNull();
        expect(info.content!.equals(nftContent)).toBe(true);
    });

    it('request_owner omits content when withContent is false', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 34));
        const nftContent = beginCell().storeStringTail('hidden.json').endCell();
        const runtimeData = createRuntimeData(operatorKeys, nftContent);
        const { wallet } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const result = await wallet.sendRequestOwner(stranger.getSender(), toNano('0.1'), {
            queryId: 51n,
            dest: helperExtension.address,
            forwardPayload: beginCell().endCell(),
            withContent: false,
        });

        const infoTx = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(wallet.address) &&
                tx.inMessage.info.dest.equals(helperExtension.address),
        );
        const info = parseOwnerInfo(infoTx!.inMessage!.body);
        expect(info.queryId).toBe(51n);
        expect(info.content).toBeNull();
    });

    // --- TEP-85 SBT: bounced ownership_proof ---

    it('forwards bounced ownership_proof to owner as ownership_proof_bounced', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 35));
        const runtimeData = createRuntimeData(operatorKeys);
        const { wallet } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const nonExistentDest = new Address(0, Buffer.alloc(32, 0xde));
        const result = await wallet.sendProveOwnership(owner.getSender(), toNano('0.5'), {
            queryId: 60n,
            dest: nonExistentDest,
            forwardPayload: beginCell().endCell(),
            withContent: false,
        });

        expect(result.transactions).toHaveTransaction({
            from: wallet.address,
            to: nonExistentDest,
            success: false,
        });

        const bouncedNotifTx = result.transactions.find(
            (tx) =>
                tx.inMessage?.info.type === 'internal' &&
                tx.inMessage.info.src.equals(wallet.address) &&
                tx.inMessage.info.dest.equals(owner.address) &&
                tx.inMessage.body.beginParse().preloadUint(32) === 0xc18e86d2,
        );
        expect(bouncedNotifTx).toBeDefined();
        const parsed = parseOwnershipProofBounced(bouncedNotifTx!.inMessage!.body);
        expect(parsed.queryId).toBe(60n);
    });

    // --- TEP-85 SBT: getters ---

    it('returns SBT authority addr_none and revoked_time 0', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 36));
        const runtimeData = createRuntimeData(operatorKeys);
        const { wallet } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        expect(await wallet.getAuthorityAddress()).toBeNull();
        expect(await wallet.getRevokedTime()).toBe(0);
    });

    // --- SBT guard: forbidden opcodes ---

    it('rejects forbidden SBT opcodes (transfer, destroy, revoke, take_excess)', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 37));
        const runtimeData = createRuntimeData(operatorKeys);
        const { wallet } = openWalletByRuntimeData(runtimeData);
        await deployWallet(wallet, owner, runtimeData);

        const forbiddenOps = [
            { name: 'transfer', op: 0x5fcc3d14 },
            { name: 'destroy', op: 0x1f04537a },
            { name: 'revoke', op: 0x6f89f5e3 },
            { name: 'take_excess', op: 0xd136d3b3 },
        ];

        for (const { name, op } of forbiddenOps) {
            const body = beginCell().storeUint(op, 32).storeUint(0, 64).endCell();
            const result = await wallet.sendInternal(stranger.getSender(), {
                value: toNano('0.05'),
                bounce: true,
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                body,
            });
            expect(result.transactions).toHaveTransaction({
                from: stranger.address,
                to: wallet.address,
                exitCode: 0xffff,
                success: false,
            });
        }
    });
});
