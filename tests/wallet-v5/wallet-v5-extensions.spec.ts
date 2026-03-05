import {Blockchain, BlockchainTransaction, SandboxContract} from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, Sender, SendMode, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed } from '@ton/crypto';
import { AgenticWallet, bufferToUint256, calculateWalletIndex, WalletRuntimeData } from '../../wrappers/AgenticWallet';
import { bufferToBigInt, createMsgInternal, packAddress, randomAddress, validUntil } from './utils';
import {
    ActionAddExtension,
    ActionRemoveExtension,
    ActionSendMsg, ActionSetSignatureAuthAllowed,
    packActionsList
} from './actions';
import { TransactionDescriptionGeneric } from '@ton/core/src/types/TransactionDescription';
import { TransactionComputeVm } from '@ton/core/src/types/TransactionComputePhase';
import { default as config } from './config';
import {
    createBodyForAgenticWallet,
    AgenticWalletV5Test,
    TestWallet,
} from './custom-agentic-wallet-v5';

let walletId = 0n; // CUSTOM: AgenticWallet uses uint256 nft index in place of wallet-v5 walletId.

describe('Wallet V5 extensions auth', () => {
    let code: Cell;

    beforeAll(async () => {
        // CUSTOM: compile AgenticWallet instead of wallet_v5.
        code = await compile('AgenticWallet');
    });

    let blockchain: Blockchain;
    let walletV5: SandboxContract<TestWallet>;
    let keypair: KeyPair;
    let sender: Sender;
    let seqno: number;

    let ggc: bigint = BigInt(0);
    function accountForGas(transactions: BlockchainTransaction[]) {
        transactions.forEach((tx) => {
            ggc += ((tx?.description as TransactionDescriptionGeneric)?.computePhase as TransactionComputeVm)?.gasUsed ?? BigInt(0);
        })
    }

    afterAll(async() => {
        console.log("EXTENSIONS TESTS: Total gas " + ggc);
    });

    function createBody(actionsList: Cell) {
        const body = createBodyForAgenticWallet({
            actionsList,
            walletId,
            seqno,
            validUntil: validUntil(),
            secretKey: keypair.secretKey,
        });

        seqno++;
        return body;
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        keypair = keyPairFromSeed(await getSecureRandomBytes(32));

        const deployer = await blockchain.treasury('deployer');
        sender = deployer.getSender();

        // CUSTOM: AgenticWallet state init needs immutable nftItemIndex and collectionAddress.
        const runtimeData: WalletRuntimeData = {
            ownerAddress: deployer.address,
            nftItemContent: null,
            originOperatorPublicKey: bufferToUint256(keypair.publicKey),
            operatorPublicKey: bufferToUint256(keypair.publicKey),
            deployedByUser: true,
        };
        walletId = calculateWalletIndex(runtimeData.ownerAddress, runtimeData.originOperatorPublicKey, true);
        walletV5 = blockchain.openContract(
            new AgenticWalletV5Test(
                AgenticWallet.createFromConfig(
                    {
                        nftItemIndex: walletId,
                        collectionAddress: randomAddress(),
                    },
                    code,
                ),
            ),
        );

        const deployResult = await walletV5.sendDeployWallet(deployer.getSender(), toNano('0.2'), {
            // CUSTOM: AgenticWallet initialization uses DeployWalletMsg with runtime data.
            queryId: 1n,
            walletData: runtimeData,
        });

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: walletV5.address,
            deploy: true,
            success: true
        });
        walletId = await walletV5.getWalletId();

        seqno = 0;
    });

    it('Do a transfer form extension', async () => {
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)]))
        });

        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;

        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });

        const actions = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        if (config.microscope)
            blockchain.verbosity = { ...blockchain.verbosity, blockchainLogs: true, vmLogs: 'vm_logs_gas', debugLogs: true, print: true }

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actions
        });

        if (config.microscope)
            blockchain.verbosity = { ...blockchain.verbosity, blockchainLogs: false, vmLogs: 'none', debugLogs: false, print: false }

        expect(receipt.transactions.length).toEqual(3);
        accountForGas(receipt.transactions);

        expect(receipt.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const fee = receipt.transactions[2].totalFees.coins;
        console.debug(
            'SINGLE INTERNAL TRANSFER FROM EXTENSION GAS USED:',
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).gasUsed
        );

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
    });

    it('Do two transfers form extension and add other extension', async () => {
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)]))
        });

        const testOtherExtension = Address.parse(
            'EQCNjd2CuSmxLpS5gUjyhRhVOsA1GaacsRPOBFV-WJRR_RmS'
        );

        const testReceiver1 = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue1 = toNano(0.001);

        const testReceiver2 = Address.parse('EQCgYDKqfTh7zVj9BQwOIPs4SuOhM7wnIjb6bdtM2AJf_Z9G');
        const forwardValue2 = toNano(0.0012);

        const receiver1BalanceBefore = (await blockchain.getContract(testReceiver1)).balance;
        const receiver2BalanceBefore = (await blockchain.getContract(testReceiver2)).balance;

        const msg1 = createMsgInternal({ dest: testReceiver1, value: forwardValue1 });
        const msg2 = createMsgInternal({ dest: testReceiver2, value: forwardValue2 });

        const actions = packActionsList([
            new ActionAddExtension(testOtherExtension),
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg1),
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg2)
        ]);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actions
        });

        expect(receipt.transactions.length).toEqual(4);
        accountForGas(receipt.transactions);

        expect(receipt.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver1,
            value: forwardValue1
        });
        expect(receipt.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver2,
            value: forwardValue2
        });

        const fee1 = receipt.transactions[2].totalFees.coins;
        const fee2 = receipt.transactions[3].totalFees.coins;

        const receiver1BalanceAfter = (await blockchain.getContract(testReceiver1)).balance;
        const receiver2BalanceAfter = (await blockchain.getContract(testReceiver2)).balance;
        expect(receiver1BalanceAfter).toEqual(receiver1BalanceBefore + forwardValue1 - fee1);
        expect(receiver2BalanceAfter).toEqual(receiver2BalanceBefore + forwardValue2 - fee2);

        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );

        expect(extensionsDict.size).toEqual(2);

        expect(extensionsDict.get(packAddress((sender as any).address!))).toEqual(
            -1n
        );
        expect(extensionsDict.get(packAddress(testOtherExtension))).toEqual(
            -1n
        );
    });

    it('Add and remove other extension form extension', async () => {
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)]))
        });

        const otherExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');

        const actions1 = packActionsList([new ActionAddExtension(otherExtension)]);
        const receipt1 = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actions1
        });

        expect(receipt1.transactions.length).toEqual(2);
        accountForGas(receipt1.transactions);

        const extensionsDict1 = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );
        expect(extensionsDict1.size).toEqual(2);
        expect(extensionsDict1.get(packAddress((sender as any).address!))).toEqual(
            -1n
        );
        expect(extensionsDict1.get(packAddress(otherExtension))).toEqual(
            -1n
        );

        const actions2 = packActionsList([new ActionRemoveExtension(otherExtension)]);
        const receipt2 = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actions2
        });

        expect(receipt2.transactions.length).toEqual(2);
        accountForGas(receipt2.transactions);

        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );
        expect(extensionsDict.size).toEqual(1);
        expect(extensionsDict.get(packAddress((sender as any).address!))).toEqual(
            -1n
        );
        expect(extensionsDict.get(packAddress(otherExtension))).toEqual(undefined);
    });

    it('Extension removes itself', async () => {
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)]))
        });

        const actions = packActionsList([new ActionRemoveExtension((sender as any).address!)]);
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actions
        });

        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);

        const extensionsDict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            Dictionary.Values.BigInt(1),
            await walletV5.getExtensions()
        );
        expect(extensionsDict.size).toEqual(0);
        expect(extensionsDict.get(packAddress((sender as any).address!))).toEqual(undefined);
    });

    it('Extension must be in the dict to pass authorization', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const outsider = await blockchain.treasury('outsider'); // CUSTOM: owner is allowed on extension path in AgenticWallet, so unauthorized check must use a non-owner sender.

        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });

        const actions = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const receipt = await walletV5.sendInternalMessageFromExtension(outsider.getSender(), {
            value: toNano('0.1'),
            body: actions
        });

        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);

        expect(receipt.transactions).not.toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        // Note that some random contract may have deposited funds with this prefix,
        // so we accept the funds silently instead of throwing an error (wallet v4 does the same).
        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Disallow signature auth and do a transfer from extension', async () => {
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension((sender as any).address!)
            ]))
        });

        const receipt0 = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: packActionsList([new ActionSetSignatureAuthAllowed(false)])
        });

        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;

        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });

        const actions = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)]);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: actions
        });

        expect(receipt.transactions.length).toEqual(3);
        accountForGas(receipt.transactions);

        expect(receipt.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const fee = receipt.transactions[2].totalFees.coins;
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
        void receipt0;
    });

    it('Disallow signature auth; re-allow and self-delete by extension; do signed transfer', async () => {
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension((sender as any).address!)
            ]))
        });

         await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: packActionsList([
                new ActionSetSignatureAuthAllowed(false)
            ])
        });

        const isSignatureAuthAllowed = await walletV5.getIsSecretKeyAuthEnabled();
        expect(isSignatureAuthAllowed).toEqual(false);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: packActionsList([
                new ActionSetSignatureAuthAllowed(true),
                new ActionRemoveExtension((sender as any).address!)
            ])
        });

        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const isSignatureAuthAllowed1 = await walletV5.getIsSecretKeyAuthEnabled();
        expect(isSignatureAuthAllowed1).toEqual(true);

        const contract_seqno = await walletV5.getSeqno();
        expect(contract_seqno).toEqual(seqno);

        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;

        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });

        const actionsList2 = packActionsList([
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)
        ]);

        const receipt2 = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList2)
        });

        expect(receipt2.transactions.length).toEqual(3);
        accountForGas(receipt2.transactions);

        expect(receipt2.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const fee = receipt2.transactions[2].totalFees.coins;
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
    });

    it('Add ext; disallow signature auth by ext; re-allow and self-delete by extension; do signed transfer', async () => {
        await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(packActionsList([
                new ActionAddExtension((sender as any).address!)
            ]))
        });

        const isSignatureAuthAllowed = await walletV5.getIsSecretKeyAuthEnabled();
        expect(isSignatureAuthAllowed).toEqual(true);

        const receipt0 = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: packActionsList([
                new ActionSetSignatureAuthAllowed(false)
            ])
        });

        expect(receipt0.transactions.length).toEqual(2);
        accountForGas(receipt0.transactions);

        expect(
            (
                (receipt0.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const isSignatureAuthAllowed0 = await walletV5.getIsSecretKeyAuthEnabled();
        expect(isSignatureAuthAllowed0).toEqual(false);

        const receipt = await walletV5.sendInternalMessageFromExtension(sender, {
            value: toNano('0.1'),
            body: packActionsList([
                new ActionSetSignatureAuthAllowed(true),
                new ActionRemoveExtension((sender as any).address!)
            ])
        });

        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);

        expect(
            (
                (receipt.transactions[1].description as TransactionDescriptionGeneric)
                    .computePhase as TransactionComputeVm
            ).exitCode
        ).toEqual(0);

        const isSignatureAuthAllowed1 = await walletV5.getIsSecretKeyAuthEnabled();
        expect(isSignatureAuthAllowed1).toEqual(true);

        const contract_seqno = await walletV5.getSeqno();
        expect(contract_seqno).toEqual(seqno);

        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);

        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;

        const msg = createMsgInternal({ dest: testReceiver, value: forwardValue });

        const actionsList2 = packActionsList([
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, msg)
        ]);

        const receipt2 = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: createBody(actionsList2)
        });

        expect(receipt2.transactions.length).toEqual(3);
        accountForGas(receipt2.transactions);

        expect(receipt2.transactions).toHaveTransaction({
            from: walletV5.address,
            to: testReceiver,
            value: forwardValue
        });

        const fee = receipt2.transactions[2].totalFees.coins;
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
    });
});
