import { toNano } from '@ton/core';
import { buildOnchainMetadata, NftCollection } from '../wrappers/NftCollection';
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
                content: buildOnchainMetadata({
                    uri: 'https://webdom.market/agentic_wallets/collection.json',
                    name: 'Agentic Wallets',
                    description: 'Test collection of agentic wallets',
                }),
                nftItemCode: walletCode,
            },
            collectionCode,
        ),
    );

    await nftCollection.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(nftCollection.address);
}
