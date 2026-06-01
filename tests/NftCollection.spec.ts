import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import {
    AgenticWallet,
    WalletRuntimeData,
    bufferToUint256,
    calculateWalletIndex,
} from '../wrappers/AgenticWallet';
import { buildOnchainMetadata, NftCollection, nftCollectionConfigToCell } from '../wrappers/NftCollection';
import { keyPairFromSeed } from '@ton/crypto';
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
    let collectionMetadata: Cell;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        user = await blockchain.treasury('user');
        outsider = await blockchain.treasury('outsider');
        collectionMetadata = buildOnchainMetadata({
            name: 'Agentic Wallets',
            description: 'Collection metadata for tests',
        });

        nftCollection = blockchain.openContract(
            NftCollection.createFromConfig(
                {
                    adminAddress: admin.address,
                    content: collectionMetadata,
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

    function createRuntimeData(): WalletRuntimeData {
        const operatorKeys = keyPairFromSeed(Buffer.alloc(32, 31));
        return {
            ownerAddress: user.address,
            nftItemContent: beginCell().storeStringTail('item-808.json').endCell(),
            originOperatorPublicKey: bufferToUint256(operatorKeys.publicKey),
            operatorPublicKey: bufferToUint256(operatorKeys.publicKey),
            deployedByUser: true,
        };
    }

    it('keeps collection getters and admin rotation intact', async () => {
        const data = await nftCollection.getCollectionData();
        expect(data.nextItemIndex).toBe(-1);
        expect(data.collectionMetadata.equals(collectionMetadata)).toBe(true);
        expect(data.adminAddress.equals(admin.address)).toBe(true);

        const royalty = await nftCollection.getRoyaltyParams();
        expect(royalty.numerator).toBe(0);
        expect(royalty.denominator).toBe(0);
        expect(royalty.destination).toBeNull();

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

        const changedData = await nftCollection.getCollectionData();
        expect(changedData.adminAddress.equals(user.address)).toBe(true);
    });

    it('allows admin to change collection content', async () => {
        const updatedContent = buildOnchainMetadata({
            name: 'Agentic Wallets v2',
            description: 'Updated collection metadata',
        });

        const forbidden = await nftCollection.sendChangeCollectionContent(
            outsider.getSender(),
            toNano('0.05'),
            200n,
            updatedContent,
        );
        expect(forbidden.transactions).toHaveTransaction({
            from: outsider.address,
            to: nftCollection.address,
            exitCode: 50,
            success: false,
        });

        const dataBefore = await nftCollection.getCollectionData();
        expect(dataBefore.collectionMetadata.equals(collectionMetadata)).toBe(true);

        const changed = await nftCollection.sendChangeCollectionContent(
            admin.getSender(),
            toNano('0.05'),
            201n,
            updatedContent,
        );
        expect(changed.transactions).toHaveTransaction({
            from: admin.address,
            to: nftCollection.address,
            success: true,
        });

        const dataAfter = await nftCollection.getCollectionData();
        expect(dataAfter.collectionMetadata.equals(updatedContent)).toBe(true);
    });

    it('allows admin to upgrade collection data and code', async () => {
        const newData = nftCollectionConfigToCell({
            adminAddress: user.address,
            content: collectionMetadata,
            nftItemCode: walletCode,
        });

        const forbidden = await nftCollection.sendChangeCollectionDataAndCode(
            outsider.getSender(),
            toNano('0.05'),
            300n,
            newData,
            collectionCode,
        );
        expect(forbidden.transactions).toHaveTransaction({
            from: outsider.address,
            to: nftCollection.address,
            exitCode: 50,
            success: false,
        });

        const changed = await nftCollection.sendChangeCollectionDataAndCode(
            admin.getSender(),
            toNano('0.05'),
            301n,
            newData,
            collectionCode,
        );
        expect(changed.transactions).toHaveTransaction({
            from: admin.address,
            to: nftCollection.address,
            success: true,
        });

        const dataAfter = await nftCollection.getCollectionData();
        expect(dataAfter.adminAddress.equals(user.address)).toBe(true);
    });

    it('returns onchain individual nft metadata content', async () => {
        const individualMetadata = buildOnchainMetadata({
            name: 'Agentic Wallet #808',
            description: 'Individual onchain metadata',
        });

        const content = await nftCollection.getNftContent(808n, individualMetadata);
        const expected = buildOnchainMetadata({
            name: 'Agentic Wallet #808',
            description: 'Individual onchain metadata',
            image: 'https://agents.ton.org/icons/ton.png',
        });

        expect(content.equals(expected)).toBe(true);
    });

    it('derives wallet address by index consistently with local state init', async () => {
        const runtimeData = createRuntimeData();
        const itemIndex = calculateWalletIndex(runtimeData.ownerAddress, runtimeData.originOperatorPublicKey, true);
        const indexedAddress = await nftCollection.getNftAddressByIndex(itemIndex);
        const localAddress = AgenticWallet.createFromConfig(
            {
                nftItemIndex: itemIndex,
                collectionAddress: nftCollection.address,
            },
            walletCode,
        ).address;

        expect(indexedAddress.equals(localAddress)).toBe(true);
        expect((await nftCollection.getWalletAddressByOwnerAndOriginKey(user.address, runtimeData.originOperatorPublicKey, true)).equals(localAddress)).toBe(true);
    });

    it('works with wallets deployed directly to the address derived from collection indexing', async () => {
        const runtimeData = createRuntimeData();
        const itemIndex = calculateWalletIndex(runtimeData.ownerAddress, runtimeData.originOperatorPublicKey, true);
        const indexedAddress = await nftCollection.getNftAddressByIndex(itemIndex);
        const wallet = blockchain.openContract(
            AgenticWallet.createFromConfig(
                {
                    nftItemIndex: itemIndex,
                    collectionAddress: nftCollection.address,
                },
                walletCode,
            ),
        );

        expect(wallet.address.equals(indexedAddress)).toBe(true);

        const result = await wallet.sendDeployWallet(user.getSender(), toNano('0.2'), {
            queryId: 1n,
            walletData: runtimeData,
        });
        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: wallet.address,
            deploy: true,
            success: true,
        });

        const nftData = await wallet.getNftData();
        expect(nftData.isInitialized).toBe(true);
        expect(nftData.nftItemIndex).toBe(itemIndex);
        expect(nftData.collectionAddress.equals(nftCollection.address)).toBe(true);
        expect(nftData.ownerAddress?.equals(user.address)).toBe(true);
    });

    it('no longer accepts legacy deploy requests', async () => {
        const legacyBody = beginCell().storeUint(0x00000001, 32).endCell();
        const result = await outsider.send({
            to: nftCollection.address,
            value: toNano('0.05'),
            bounce: true,
            body: legacyBody,
        });

        expect(result.transactions).toHaveTransaction({
            from: outsider.address,
            to: nftCollection.address,
            exitCode: 0xffff,
            success: false,
        });
    });
});


/*
curl -sS 'https://toncenter.com/api/v3/runGetMethod' \
  -H 'content-type: application/json' \
  -H "x-api-key: c2de0a8e6e2628fcccf98b1ee23201fd1188c4e0dfd2c0bd2ad2bdb438d2adcd" \
  --data-raw '{
    "address":"EQCBXQ3koH3gyUVvF5AU2sLm6XOh_R3dV9WoVIl1b-A-_tMf",
    "method":"get_nft_address_by_index",
    "stack":[{"type":"num","value":"0"}]
  }' | jq
*/
