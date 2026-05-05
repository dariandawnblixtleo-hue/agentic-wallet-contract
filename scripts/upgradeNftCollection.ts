import { Address, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { buildOnchainMetadata, NftCollection, nftCollectionConfigToCell } from '../wrappers/NftCollection';

export async function run(provider: NetworkProvider, args: string[] = []) {
    const senderAddress = provider.sender().address;
    if (!senderAddress) {
        throw new Error('Sender address is required');
    }

    if (args.length < 1 || args.length > 2) {
        throw new Error('Usage: blueprint run upgradeNftCollection -- <collectionAddress> [walletCodeTarget]');
    }

    const collectionAddress = Address.parse(args[0]);

    const collection = provider.open(NftCollection.createFromAddress(collectionAddress));
    const currentData = await collection.getCollectionData();
    if (!currentData.adminAddress.equals(senderAddress)) {
        throw new Error(
            `Sender ${senderAddress.toString()} is not the collection admin ${currentData.adminAddress.toString()}`,
        );
    }

    const walletCode = await compile('AgenticWallet');
    const collectionCode = await compile('NftCollection');
    const newData = nftCollectionConfigToCell({
        adminAddress: currentData.adminAddress,
        content: buildOnchainMetadata({
            "name": "Agentic Wallets",
            "description": "Collection of wallets for agents on TON. Learn more on agents.ton.org",
            "image": "https://agents.ton.org/nft-image.png"
        }),
        nftItemCode: walletCode,
    });

    await collection.sendChangeCollectionDataAndCode(
        provider.sender(),
        toNano('0.02'),
        1n,
        newData,
        collectionCode,
    );

    console.log(`Collection upgrade message sent to ${collectionAddress.toString()}`);
    console.log(`New collection code hash: ${collectionCode.hash().toString('hex')}`);
    console.log(`New wallet code hash: ${walletCode.hash().toString('hex')}`);
}
