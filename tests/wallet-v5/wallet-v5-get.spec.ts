import { Blockchain, SandboxContract } from '@ton/sandbox';
import { beginCell, Cell, Dictionary, Sender, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed } from '@ton/crypto';
import { AgenticWallet, bufferToUint256, calculateWalletIndex, WalletRuntimeData } from '../../wrappers/AgenticWallet';
import { bufferToBigInt, randomAddress } from './utils';
import { ActionAddExtension, packActionsList } from './actions';
import { createBodyForAgenticWallet, TestWallet, AgenticWalletV5Test } from './custom-agentic-wallet-v5';

// CUSTOM: wallet-v5 wallet_id structure is replaced by immutable nftItemIndex in AgenticWallet.
describe('Wallet V5 get methods', () => {
    let code: Cell;

    beforeAll(async () => {
        // CUSTOM: compile AgenticWallet instead of wallet_v5.
        code = await compile('AgenticWallet');
    });

    let blockchain: Blockchain;
    let walletV5: SandboxContract<TestWallet>;
    let keypair: KeyPair;
    let sender: Sender;
    let walletId = 0n;
    let runtimeData: WalletRuntimeData;

    async function deploy(params?: {
        seqno?: number;
        publicKey?: Buffer;
        extensions?: Dictionary<bigint, bigint>;
    }) {
        blockchain = await Blockchain.create();
        if (!params?.publicKey) {
            keypair = keyPairFromSeed(await getSecureRandomBytes(32));
        }

        const deployer = await blockchain.treasury('deployer');
        sender = deployer.getSender();

        runtimeData = {
            ownerAddress: deployer.address,
            nftItemContent: null,
            // CUSTOM: wallet id is derived from owner + origin key, so publicKey directly shapes get_subwallet_id().
            originOperatorPublicKey: bufferToUint256((params?.publicKey ?? keypair.publicKey)),
            operatorPublicKey: bufferToUint256((params?.publicKey ?? keypair.publicKey)),
            deployedByUser: true,
        };
        walletId = calculateWalletIndex(runtimeData.ownerAddress, runtimeData.originOperatorPublicKey, true);

        walletV5 = blockchain.openContract(
            new AgenticWalletV5Test(
                AgenticWallet.createFromConfig(
                    {
                        nftItemIndex: walletId,
                        // CUSTOM: get-method tests do not require a real collection contract.
                        collectionAddress: randomAddress(),
                    },
                    code
                )
            )
        );

        const deployResult = await walletV5.sendDeployWallet(sender, toNano('0.2'), {
            // CUSTOM: AgenticWallet initializes via DeployWalletMsg, not by preloaded config cell.
            queryId: 1n,
            walletData: runtimeData,
        });

        if (params?.seqno) {
            for (let i = 0; i < params.seqno; i++) {
                await walletV5.sendInternalSignedMessage(sender, {
                    value: toNano('0.1'),
                    // CUSTOM: seqno is advanced through valid signed requests because AgenticWallet cannot start with arbitrary seqno in state.
                    body: createBodyForAgenticWallet({
                        actionsList: beginCell().storeUint(0, 1).storeUint(0, 1).endCell(),
                        walletId,
                        seqno: i,
                        validUntil: Math.floor((Date.now() + 60_000) / 1000),
                        secretKey: keypair.secretKey,
                    }),
                });
            }
        }

        return { deployer, deployResult };
    }

    beforeEach(async () => {
        const { deployer, deployResult } = await deploy();

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: walletV5.address,
            deploy: true,
            success: true
        });
    });

    it('Get seqno', async () => {
        const expectedSeqno = 3;
        const { deployer, deployResult } = await deploy({ seqno: expectedSeqno });
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: walletV5.address,
            deploy: true,
            success: true
        });
        const actualSeqno = await walletV5.getSeqno();
        expect(expectedSeqno).toEqual(actualSeqno);
    });

    it('Get pubkey', async () => {
        const actualPubkey = await walletV5.getPublicKey();
        expect(actualPubkey).toEqual(bufferToBigInt(keypair.publicKey));
    });

    it('Get wallet id', async () => {
        const customKeypair = keyPairFromSeed(await getSecureRandomBytes(32));
        const { deployer, deployResult } = await deploy({ publicKey: customKeypair.publicKey });
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: walletV5.address,
            deploy: true,
            success: true
        });

        // CUSTOM: AgenticWallet returns nftItemIndex from owner+origin key instead of packed wallet-v5 wallet_id.
        const expectedWalletId = calculateWalletIndex(deployer.address, bufferToUint256(customKeypair.publicKey), true);
        const actualWalletId = await walletV5.getWalletId();
        expect(actualWalletId).toEqual(expectedWalletId);
    });

    it('Get subwallet number', async () => {
        // CUSTOM: wallet-v5 parsed subwallet number has no direct analogue; verify nftItemIndex is preserved in get_nft_data().
        const actualWalletId = await walletV5.getWalletId();
        const nftData = await walletV5.getNftData();
        expect(nftData.nftItemIndex).toEqual(actualWalletId);
    });

    it('Default wallet id', async () => {
        // Deploying default wallet
        await deploy();
        // CUSTOM: default id is the derived nftItemIndex of the currently deployed wallet.
        expect(await walletV5.getWalletId()).toBe(walletId);
    });

    it('Get extensions dict', async () => {
        const plugin1 = randomAddress();
        const plugin2 = randomAddress();

        const extensions: Dictionary<bigint, bigint> = Dictionary.empty(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1)
        );
        extensions.set(bufferToBigInt(plugin1.hash), -1n);
        extensions.set(bufferToBigInt(plugin2.hash), -1n);

        const { deployer, deployResult } = await deploy();
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: walletV5.address,
            deploy: true,
            success: true
        });

        // CUSTOM: AgenticWallet starts with empty extensions, so populate them through owner extension-action requests after deploy.
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano('0.1'),
            body: createBodyForAgenticWallet({
                actionsList: packActionsList([new ActionAddExtension(plugin1), new ActionAddExtension(plugin2)]),
                walletId,
                seqno: 0,
                validUntil: Math.floor((Date.now() + 60_000) / 1000),
                secretKey: keypair.secretKey,
            }),
        });

        const actual = await walletV5.getExtensions();
        const expected = beginCell()
            .storeDictDirect(extensions, Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1))
            .endCell();
        expect(actual?.equals(expected)).toBeTruthy();
    });

    it('Get extensions array', async () => {
        const plugin1 = randomAddress();
        const plugin2 = randomAddress();
        const plugin3 = randomAddress();

        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano('0.1'),
            body: createBodyForAgenticWallet({
                actionsList: packActionsList([
                    new ActionAddExtension(plugin1),
                    new ActionAddExtension(plugin2),
                    new ActionAddExtension(plugin3),
                ]),
                walletId,
                seqno: 0,
                validUntil: Math.floor((Date.now() + 60_000) / 1000),
                secretKey: keypair.secretKey,
            }),
        });

        const actual = await walletV5.getExtensionsArray();
        expect(actual.length).toBe(3);
        expect(actual.some((addr) => addr.equals(plugin1))).toBeTruthy();
        expect(actual.some((addr) => addr.equals(plugin2))).toBeTruthy();
        expect(actual.some((addr) => addr.equals(plugin3))).toBeTruthy();
    });

    it('Get empty extensions array', async () => {
        const actual = await walletV5.getExtensionsArray();
        expect(actual.length).toBe(0);
    });
});
