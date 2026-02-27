import { toNano } from '@ton/core';
import { AgenticWallet } from '../wrappers/AgenticWallet';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const agenticWallet = provider.open(AgenticWallet.createFromConfig({}, await compile('AgenticWallet')));

    await agenticWallet.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(agenticWallet.address);

    // run methods on `agenticWallet`
}
