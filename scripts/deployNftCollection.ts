import { beginCell, toNano } from '@ton/core';
import { NftCollection } from '../wrappers/NftCollection';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const adminAddress = provider.sender().address;
    if (!adminAddress) {
        throw new Error('Sender address is required');
    }

    const walletCode = await compile('AgenticWallet');
    const collectionCode = await compile('NftCollection');
    const nftCollection = provider.open(
        NftCollection.createFromConfig(
            {
                adminAddress,
                content: {
                    collectionMetadata: beginCell().storeStringTail('https://meta.example/collection.json').endCell(),
                    commonContent: 'https://meta.example/items/',
                },
                nftItemCode: walletCode,
            },
            collectionCode,
        ),
    );

    await nftCollection.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(nftCollection.address);
}
