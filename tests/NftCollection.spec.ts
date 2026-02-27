import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { AgenticWallet, agenticWalletDataToCell, bufferToUint256 } from '../wrappers/AgenticWallet';
import { NftCollection } from '../wrappers/NftCollection';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

describe('NftCollection', () => {
    let collectionCode: Cell;
    let walletCode: Cell;

    beforeAll(async () => {
        collectionCode = await compile('NftCollection');
        walletCode = await compile('AgenticWallet');
    });

    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let outsider: SandboxContract<TreasuryContract>;
    let nftCollection: SandboxContract<NftCollection>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        user = await blockchain.treasury('user');
        outsider = await blockchain.treasury('outsider');

        nftCollection = blockchain.openContract(
            NftCollection.createFromConfig(
                {
                    adminAddress: admin.address,
                    content: {
                        collectionMetadata: beginCell().storeStringTail('https://meta.example/collection.json').endCell(),
                        commonContent: 'https://meta.example/items/',
                    },
                    nftItemCode: walletCode,
                },
                collectionCode,
            ),
        );

        const deployResult = await nftCollection.sendDeploy(admin.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: nftCollection.address,
            deploy: true,
            success: true,
        });
    });

    it('returns collection getters', async () => {
        const data = await nftCollection.getCollectionData();
        expect(data.nextItemIndex).toBe(-1);
        expect(data.adminAddress.equals(admin.address)).toBe(true);

        const royalty = await nftCollection.getRoyaltyParams();
        expect(royalty.numerator).toBe(0);
        expect(royalty.denominator).toBe(0);
        expect(royalty.destination).toBeNull();
    });

    it('allows admin rotation only from current admin', async () => {
        const forbidden = await nftCollection.sendChangeCollectionAdmin(
            outsider.getSender(),
            toNano('0.05'),
            100n,
            outsider.address,
        );
        expect(forbidden.transactions).toHaveTransaction({
            from: outsider.address,
            to: nftCollection.address,
            exitCode: 50,
            success: false,
        });

        const changed = await nftCollection.sendChangeCollectionAdmin(admin.getSender(), toNano('0.05'), 101n, user.address);
        expect(changed.transactions).toHaveTransaction({
            from: admin.address,
            to: nftCollection.address,
            success: true,
        });

        const data = await nftCollection.getCollectionData();
        expect(data.adminAddress.equals(user.address)).toBe(true);
    });

    it('deploys agentic wallet for a valid signed request', async () => {
        const masterKeys = keyPairFromSeed(Buffer.alloc(32, 11));
        const agentKeys = keyPairFromSeed(Buffer.alloc(32, 12));
        const initParamsCell = agenticWalletDataToCell({
            subwalletId: 777,
            agentPublicKey: bufferToUint256(agentKeys.publicKey),
            masterPublicKey: bufferToUint256(masterKeys.publicKey),
            masterWalletAddress: user.address,
            nftItemContent: beginCell().storeStringTail('item-777.json').endCell(),
        });
        const userSignature = sign(initParamsCell.hash(), masterKeys.secretKey);
        const itemIndex = BigInt(`0x${initParamsCell.hash().toString('hex')}`);
        const nftAddress = await nftCollection.getNftAddressByIndex(itemIndex);

        const result = await nftCollection.sendRequestDeployNft(user.getSender(), toNano('0.2'), {
            queryId: 1n,
            userSignature,
            initParams: initParamsCell,
        });
        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: nftCollection.address,
            success: true,
        });
        expect(result.transactions).toHaveTransaction({
            to: nftAddress,
            deploy: true,
            success: true,
        });

        const deployedWallet = blockchain.openContract(AgenticWallet.createFromAddress(nftAddress));
        expect(await deployedWallet.getSubwalletId()).toBe(777);
        expect(await deployedWallet.getPublicKey()).toBe(bufferToUint256(masterKeys.publicKey));

        const nftData = await deployedWallet.getNftData();
        expect(nftData.isInitialized).toBe(true);
        expect(nftData.collectionAddress.equals(nftCollection.address)).toBe(true);
        expect(nftData.ownerAddress?.equals(user.address)).toBe(true);
    });

    it('rejects deploy request with invalid user signature', async () => {
        const masterKeys = keyPairFromSeed(Buffer.alloc(32, 21));
        const wrongSigner = keyPairFromSeed(Buffer.alloc(32, 22));
        const initParamsCell = agenticWalletDataToCell({
            subwalletId: 778,
            agentPublicKey: bufferToUint256(keyPairFromSeed(Buffer.alloc(32, 23)).publicKey),
            masterPublicKey: bufferToUint256(masterKeys.publicKey),
            masterWalletAddress: user.address,
            nftItemContent: null,
        });
        const invalidSignature = sign(initParamsCell.hash(), wrongSigner.secretKey);
        const itemIndex = BigInt(`0x${initParamsCell.hash().toString('hex')}`);
        const nftAddress = await nftCollection.getNftAddressByIndex(itemIndex);

        const result = await nftCollection.sendRequestDeployNft(user.getSender(), toNano('0.2'), {
            queryId: 2n,
            userSignature: invalidSignature,
            initParams: initParamsCell,
        });
        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: nftCollection.address,
            exitCode: 135,
            success: false,
        });

        const nftContract = await blockchain.getContract(nftAddress);
        expect(nftContract.accountState?.type ?? 'uninit').toBe('uninit');
    });
});
