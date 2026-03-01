import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, internal, SendMode, storeOutList, toNano } from '@ton/core';
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
    createRemoveExtensionExtraAction,
    createSetSignatureAllowedExtraAction,
    createSnakedExtraActions,
    walletIndexSeedToCell,
    WalletRuntimeData,
} from '../wrappers/AgenticWallet';
import { NftCollection } from '../wrappers/NftCollection';
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
                    content: {
                        collectionMetadata: beginCell().storeStringTail('https://meta.example/collection.json').endCell(),
                        commonContent: 'https://meta.example/items/',
                    },
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

    function createRuntimeData(operatorKeys: { publicKey: Buffer }, nftItemContent: Cell | null = null): WalletRuntimeData {
        const publicKey = bufferToUint256(operatorKeys.publicKey);
        return {
            ownerAddress: owner.address,
            nftItemContent,
            originOperatorPublicKey: publicKey,
            operatorPublicKey: publicKey,
        };
    }

    function openWalletByRuntimeData(runtimeData: WalletRuntimeData, nftItemIndex?: bigint) {
        const index = nftItemIndex ?? calculateWalletIndex(runtimeData.ownerAddress, runtimeData.originOperatorPublicKey);
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
        hasExtraActions?: boolean;
    }) {
        const signable = createExternalSignedRequestBodyWithoutSignature({
            walletNftIndex: params.walletNftIndex,
            validUntil: params.validUntil,
            seqno: params.seqno,
            outActions: params.outActions ?? null,
            extraActions: params.extraActions ?? null,
            hasExtraActions: params.hasExtraActions,
        });
        return {
            walletNftIndex: params.walletNftIndex,
            validUntil: params.validUntil,
            seqno: params.seqno,
            outActions: params.outActions ?? null,
            extraActions: params.extraActions ?? null,
            hasExtraActions: params.hasExtraActions,
            signature: sign(signable.hash(), params.secretKey),
        };
    }

    it('serializes wallet helpers consistently', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 10));
        const runtimeData = createRuntimeData(operatorKeys, beginCell().storeStringTail('item-777.json').endCell());
        const expectedIndex = BigInt(`0x${walletIndexSeedToCell({
            ownerAddress: owner.address,
            originOperatorPublicKey: runtimeData.originOperatorPublicKey,
        }).hash().toString('hex')}`);

        expect(calculateWalletIndex(owner.address, runtimeData.originOperatorPublicKey)).toBe(expectedIndex);

        const initCell = beginCell()
            .storeAddress(owner.address)
            .storeMaybeRef(runtimeData.nftItemContent)
            .storeUint(runtimeData.originOperatorPublicKey, 256)
            .storeUint(runtimeData.operatorPublicKey, 256)
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

    it('rejects deploy with mismatched wallet index and keeps wallet logically uninitialized', async () => {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 3));
        const runtimeData = createRuntimeData(operatorKeys);
        const wrongIndex = calculateWalletIndex(owner.address, bufferToUint256(keyPairFromSeed(Buffer.alloc(32, 4)).publicKey));
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
        const walletBData = createRuntimeData(operatorB);

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
        const walletBData = createRuntimeData(operatorB);

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
            hasExtraActions: false,
        });
        await wallet.sendInternalSignedRequest(stranger.getSender(), toNano('0.05'), {
            walletNftIndex: index,
            validUntil,
            seqno: 0,
            outActions: null,
            extraActions: null,
            hasExtraActions: false,
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
});
