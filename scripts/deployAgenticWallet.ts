import { Address, toNano } from '@ton/core';
import { AgenticWallet, calculateWalletIndex } from '../wrappers/AgenticWallet';
import { NftCollection } from '../wrappers/NftCollection';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider, args: string[] = []) {
    const senderAddress = provider.sender().address;
    if (!senderAddress) {
        throw new Error('Sender address is required');
    }
    if (args.length < 2) {
        throw new Error('Usage: blueprint run deployAgenticWallet -- <collectionAddress> <operatorPublicKeyHex>');
    }

    const collectionAddress = Address.parse(args[0]);
    const operatorPublicKey = BigInt(args[1]);
    const walletIndex = calculateWalletIndex(senderAddress, operatorPublicKey, true);

    const collection = provider.open(NftCollection.createFromAddress(collectionAddress));
    const walletCode = await compile('AgenticWallet');
    const wallet = provider.open(
        AgenticWallet.createFromConfig(
            {
                nftItemIndex: walletIndex,
                collectionAddress,
            },
            walletCode,
        ),
    );

    const indexedAddress = await collection.getNftAddressByIndex(walletIndex);
    if (!indexedAddress.equals(wallet.address)) {
        throw new Error('Collection-derived wallet address does not match local stateInit');
    }

    await wallet.sendDeployWallet(provider.sender(), toNano('0.2'), {
        queryId: 0n,
        walletData: {
            ownerAddress: senderAddress,
            nftItemContent: null,
            originOperatorPublicKey: operatorPublicKey,
            operatorPublicKey,
            deployedByUser: true,
        },
    });

    await provider.waitForDeploy(wallet.address);
}
