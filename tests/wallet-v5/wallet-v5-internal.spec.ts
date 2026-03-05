import {Blockchain, BlockchainTransaction, SandboxContract} from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, Sender, SendMode, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed, sign } from '@ton/crypto';
import { bufferToBigInt, createMsgInternal, disableConsoleError, packAddress, randomAddress, validUntil } from './utils';
import {
    ActionAddExtension,
    ActionRemoveExtension,
    ActionSendMsg, ActionSetSignatureAuthAllowed,
    packActionsList
} from './actions';
import { TransactionDescriptionGeneric } from '@ton/core/src/types/TransactionDescription';
import { TransactionComputeVm } from '@ton/core/src/types/TransactionComputePhase';
import { default as config } from './config';
import { ActionSetCode, ActionSetData } from './test-only-actions';
import { AgenticWallet, calculateWalletIndex } from '../../wrappers/AgenticWallet';
import { createBodyForAgenticWallet, Opcodes, TestWallet, AgenticWalletV5Test } from './custom-agentic-wallet-v5';

let walletId = 0n; // CUSTOM: AgenticWallet uses uint256 nft index.

describe('Wallet V5 sign auth internal', () => {
    let code: Cell;

    beforeAll(async () => {
        // CUSTOM: compile AgenticWallet instead of wallet_v5.
        code = await compile('AgenticWallet');
        console.log("Code hash:", code.hash().toString('hex'));
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
        console.log("INTERNAL TESTS: Total gas " + ggc);
    });

    async function deployOtherWallet() {
        const _keypair = keyPairFromSeed(await getSecureRandomBytes(32));
        const deployer = await blockchain.treasury(`deployer-${Math.random()}`);
        const runtimeData = {
            ownerAddress: deployer.address,
            nftItemContent: null,
            originOperatorPublicKey: BigInt('0x' + _keypair.publicKey.toString('hex')),
            operatorPublicKey: BigInt('0x' + _keypair.publicKey.toString('hex')),
            deployedByUser: true,
        };
        const _walletId = calculateWalletIndex(runtimeData.ownerAddress, runtimeData.originOperatorPublicKey, true);
        const _walletV5 = blockchain.openContract(
            new AgenticWalletV5Test(
                AgenticWallet.createFromConfig(
                    {
                        nftItemIndex: _walletId,
                        collectionAddress: randomAddress(),
                    },
                    code,
                ),
            ),
        );
        const deployResult = await _walletV5.sendDeployWallet(deployer.getSender(), toNano('0.2'), { queryId: 1n, walletData: runtimeData });
        return { sender: deployer.getSender(), walletV5: _walletV5, keypair: _keypair, deployer, deployResult };
    }

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
        const runtimeData = {
            ownerAddress: deployer.address,
            nftItemContent: null,
            originOperatorPublicKey: BigInt('0x' + keypair.publicKey.toString('hex')),
            operatorPublicKey: BigInt('0x' + keypair.publicKey.toString('hex')),
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
        const deployResult = await walletV5.sendDeployWallet(sender, toNano('0.2'), { queryId: 1n, walletData: runtimeData });
        expect(deployResult.transactions).toHaveTransaction({ from: deployer.address, to: walletV5.address, deploy: true, success: true });
        walletId = await walletV5.getWalletId();
        seqno = 0;
    });

    it('Send a simple transfer', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;

        const sendTxMsg = beginCell().storeUint(0x10, 6).storeAddress(testReceiver).storeCoins(forwardValue).storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1).storeRef(beginCell().endCell()).endCell();
        const sendTxactionAction = beginCell().storeUint(Opcodes.action_send_msg, 32).storeUint(SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS, 8).storeRef(sendTxMsg).endCell();
        const actionsList = beginCell().storeMaybeRef(beginCell().storeRef(beginCell().endCell()).storeSlice(sendTxactionAction.beginParse()).endCell()).storeUint(0, 1).endCell();

        if (config.microscope)
            blockchain.verbosity = { ...blockchain.verbosity, blockchainLogs: true, vmLogs: 'vm_logs_gas', debugLogs: true, print: true }

        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(actionsList) });

        if (config.microscope)
            blockchain.verbosity = { ...blockchain.verbosity, blockchainLogs: false, vmLogs: 'none', debugLogs: false, print: false }

        expect(receipt.transactions.length).toEqual(3);
        accountForGas(receipt.transactions);
        expect(receipt.transactions).toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const fee = receipt.transactions[2].totalFees.coins;
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
    });

    it('Add an extension', async () => {
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const actionsList = beginCell().storeUint(0, 1).storeUint(1, 1).storeSlice(beginCell().storeUint(Opcodes.action_extended_add_extension, 8).storeAddress(testExtension).endCell().beginParse()).endCell();
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(actionsList) });
        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);
        const extensionsDict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1), await walletV5.getExtensions());
        expect(extensionsDict.size).toEqual(1);
        expect(extensionsDict.get(packAddress(testExtension))).toEqual(-1n);
    });

    it('Send two transfers', async () => {
        const testReceiver1 = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue1 = toNano(0.001);
        const { walletV5: testReceiver2Wallet } = await deployOtherWallet();
        const testReceiver2 = testReceiver2Wallet.address;
        const forwardValue2 = toNano(0.002);
        const receiver1BalanceBefore = (await blockchain.getContract(testReceiver1)).balance;
        const receiver2BalanceBefore = (await blockchain.getContract(testReceiver2)).balance;
        const actionsList = packActionsList([
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver1, value: forwardValue1 })),
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver2, value: forwardValue2, bounce: true })),
        ]);
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(actionsList) });
        expect(receipt.transactions.length).toEqual(4);
        accountForGas(receipt.transactions);
        expect(receipt.transactions).toHaveTransaction({ from: walletV5.address, to: testReceiver1, value: forwardValue1 });
        expect(receipt.transactions).toHaveTransaction({ from: walletV5.address, to: testReceiver2, value: forwardValue2 });
        const fee1 = receipt.transactions[2].totalFees.coins;
        const fee2 = receipt.transactions[3].totalFees.coins;
        const receiver1BalanceAfter = (await blockchain.getContract(testReceiver1)).balance;
        const receiver2BalanceAfter = (await blockchain.getContract(testReceiver2)).balance;
        expect(receiver1BalanceAfter).toEqual(receiver1BalanceBefore + forwardValue1 - fee1);
        expect(receiver2BalanceAfter).toEqual(receiver2BalanceBefore + forwardValue2 - fee2);
    });

    it('Add two extensions and do a transfer', async () => {
        const testExtension1 = Address.parse('EQA2pT4d8T7TyRsjW2BpGpGYga-lMA4JjQb4D2tc1PXMX5Bf');
        const testExtension2 = Address.parse('EQCgYDKqfTh7zVj9BQwOIPs4SuOhM7wnIjb6bdtM2AJf_Z9G');
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const actionsList = packActionsList([
            new ActionAddExtension(testExtension1),
            new ActionAddExtension(testExtension2),
            new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue })),
        ]);
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(actionsList) });
        expect(receipt.transactions.length).toEqual(3);
        accountForGas(receipt.transactions);
        expect(receipt.transactions).toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const fee = receipt.transactions[2].totalFees.coins;
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
        const extensionsDict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1), await walletV5.getExtensions());
        expect(extensionsDict.size).toEqual(2);
        expect(extensionsDict.get(packAddress(testExtension1))).toEqual(-1n);
        expect(extensionsDict.get(packAddress(testExtension2))).toEqual(-1n);
    });

    it('Remove extension', async () => {
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const receipt1 = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension(testExtension)])) });
        let extensionsDict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1), await walletV5.getExtensions());
        expect(extensionsDict.size).toEqual(1);
        expect(extensionsDict.get(packAddress(testExtension))).toEqual(-1n);
        const receipt2 = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionRemoveExtension(testExtension)])) });
        extensionsDict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1), await walletV5.getExtensions());
        expect(extensionsDict.size).toEqual(0);
        expect(extensionsDict.get(packAddress(testExtension))).toEqual(undefined);
        accountForGas(receipt1.transactions);
        accountForGas(receipt2.transactions);
    });

    it('Should fail SetData action', async () => {
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionSetData(beginCell().endCell())])) });
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(141);
    });

    it('Should fail SetCode action', async () => {
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionSetCode(beginCell().endCell())])) });
        // CUSTOM: AgenticWallet rejects set_code as invalid c5.
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(147);
    });

    it('Should fail adding existing extension', async () => {
        const testExtension = Address.parseRaw('0:' + '0'.repeat(64));
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension(testExtension)])) });
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension(testExtension)])) });
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(139);
    });

    it('Should fail removing not existing extension', async () => {
        const testExtension = Address.parseRaw('0:' + '0'.repeat(64));
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionRemoveExtension(testExtension)])) });
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(140);
    });

    it('Should fail if signature is invalid: wrong payload signed', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue }))]);
        const vu = validUntil();
        const outActions = actionsList.beginParse().loadMaybeRef();
        const payload = beginCell()
            .storeUint(Opcodes.auth_signed_internal, 32)
            .storeUint(walletId, 256)
            .storeUint(vu, 32)
            .storeUint(seqno, 32)
            .storeMaybeRef(outActions)
            .storeMaybeRef(null)
            .endCell();
        const fakePayload = beginCell()
            .storeUint(Opcodes.auth_signed_internal, 32)
            .storeUint(walletId, 256)
            .storeUint(vu, 32)
            .storeUint(seqno + 1, 32)
            .storeMaybeRef(outActions)
            .storeMaybeRef(null)
            .endCell();
        const receipt = await walletV5.sendInternalSignedMessage(sender, {
            value: toNano(0.1),
            body: beginCell().storeSlice(payload.beginParse()).storeBuffer(sign(fakePayload.hash(), keypair.secretKey)).endCell()
        });
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
        expect(receipt.transactions).not.toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should fail if signature is invalid: wrong private key used', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue }))]);
        const payload = createBodyForAgenticWallet({ actionsList, walletId, seqno, validUntil: validUntil(), secretKey: keyPairFromSeed(await getSecureRandomBytes(32)).secretKey });
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: payload });
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
        expect(receipt.transactions).not.toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should fail if seqno is invalid', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue }))]);
        const payload = createBodyForAgenticWallet({ actionsList, walletId, seqno: seqno + 1, validUntil: validUntil(), secretKey: keypair.secretKey });
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: payload });
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(133);
        expect(receipt.transactions).not.toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should fail if valid_until is expired', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue }))]);
        const payload = createBodyForAgenticWallet({ actionsList, walletId, seqno, validUntil: Math.round(Date.now() / 1000) - 600, secretKey: keypair.secretKey });
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: payload });
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(136);
        expect(receipt.transactions).not.toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should fail if subwallet id is wrong', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue }))]);
        // CUSTOM: wrong packed wallet-v5 id is replaced with wrong nftItemIndex.
        const payload = createBodyForAgenticWallet({ actionsList, walletId: 1n, seqno, validUntil: validUntil(), secretKey: keypair.secretKey });
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: payload });
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(134);
        expect(receipt.transactions).not.toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should skip message if auth kind is wrong', async () => {
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const actionsList = packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue }))]);
        const payload = createBodyForAgenticWallet({ authOpcode: Opcodes.auth_signed, actionsList, walletId, seqno, validUntil: validUntil(), secretKey: keypair.secretKey });
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: beginCell().storeSlice(payload.beginParse()).endCell() });
        expect(receipt.transactions.length).toEqual(2);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
        expect(receipt.transactions).not.toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });

    it('Should skip message if auth kind not given', async () => {
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: beginCell().endCell() });
        expect(receipt.transactions.length).toEqual(2);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
    });

    it('Should not revert on short "sint" messages', async () => {
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: beginCell().storeUint(Opcodes.auth_signed_internal, 32).endCell() });
        expect(receipt.transactions.length).toEqual(2);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
    });

    it('Should not revert on long incorrect "sint" messages', async () => {
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: beginCell().storeUint(Opcodes.auth_signed_internal, 32).storeUint(0, 657).endCell() });
        expect(receipt.transactions.length).toEqual(2);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
    });

    it('Should skip message with simple text comment', async () => {
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: beginCell().storeUint(0, 32).storeStringTail('Hello world').endCell() });
        expect(receipt.transactions.length).toEqual(2);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
    });

    it('Should skip message with longer text comment', async () => {
        const receipt = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: beginCell().storeUint(0, 32).storeStringTail('Hello world'.repeat(20)).endCell() });
        expect(receipt.transactions.length).toEqual(2);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
    });

    it('Should fail disallowing signature auth with no exts', async () => {
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)])) });
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionRemoveExtension((sender as any).address!), new ActionSetSignatureAuthAllowed(false)]) });
        expect(receipt.transactions.length).toEqual(3);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(142);
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(true);
    });

    it('Should fail allowing signature auth when allowed', async () => {
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)])) });
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionSetSignatureAuthAllowed(true)]) });
        expect(receipt.transactions.length).toEqual(3);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(143);
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(true);
    });

    it('Should add ext and disallow signature auth', async () => {
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)])) });
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionAddExtension(testExtension), new ActionSetSignatureAuthAllowed(false)]) });
        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);
        const extensionsDict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1), await walletV5.getExtensions());
        expect(extensionsDict.size).toEqual(2);
        expect(extensionsDict.get(packAddress(testExtension))).toEqual(-1n);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(false);
        expect(await walletV5.getSeqno()).toEqual(seqno);
    });

    it('Should add ext and disallow signature auth in separate txs', async () => {
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)])) });
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionAddExtension(testExtension)]) });
        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);
        let extensionsDict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1), await walletV5.getExtensions());
        expect(extensionsDict.size).toEqual(2);
        expect(extensionsDict.get(packAddress(testExtension))).toEqual(-1n);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(true);

        const receipt2 = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionSetSignatureAuthAllowed(false)]) });
        expect(receipt2.transactions.length).toEqual(2);
        accountForGas(receipt2.transactions);
        expect((((receipt2.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(false);
        expect(await walletV5.getSeqno()).toEqual(seqno);
    });

    it('Should add ext, disallow sign, allow sign, remove ext in one tx; send in other', async () => {
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)])) });
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionAddExtension(testExtension), new ActionSetSignatureAuthAllowed(false), new ActionSetSignatureAuthAllowed(true), new ActionRemoveExtension(testExtension)]) });
        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(true);
        expect(await walletV5.getSeqno()).toEqual(seqno);

        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const receipt2 = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue }))])) });
        expect(receipt2.transactions.length).toEqual(3);
        accountForGas(receipt2.transactions);
        expect(receipt2.transactions).toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const fee = receipt2.transactions[2].totalFees.coins;
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore + forwardValue - fee);
    });

    it('Should fail removing last extension with signature auth disabled', async () => {
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)])) });
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionAddExtension(testExtension), new ActionSetSignatureAuthAllowed(false), new ActionRemoveExtension(testExtension), new ActionRemoveExtension((sender as any).address!)]) });
        expect(receipt.transactions.length).toEqual(3);
        accountForGas(receipt.transactions);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(144);
        const isSignatureAuthAllowed = await walletV5.getIsSecretKeyAuthEnabled();
        expect(isSignatureAuthAllowed).toEqual(true);
    });

    it('Should fail disallowing signature auth twice in tx', async () => {
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)])) });
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionAddExtension(testExtension), new ActionSetSignatureAuthAllowed(false), new ActionSetSignatureAuthAllowed(false)]) });
        expect(receipt.transactions.length).toEqual(3);
        accountForGas(receipt.transactions);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(143);
    });

    it('Should add ext, disallow sig auth; fail different signed tx', async () => {
        await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionAddExtension((sender as any).address!)])) });
        const testExtension = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const receipt = await walletV5.sendInternalMessageFromExtension(sender, { value: toNano('0.1'), body: packActionsList([new ActionAddExtension(testExtension), new ActionSetSignatureAuthAllowed(false)]) });
        expect(receipt.transactions.length).toEqual(2);
        accountForGas(receipt.transactions);
        const extensionsDict = Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(1), await walletV5.getExtensions());
        expect(extensionsDict.size).toEqual(2);
        expect(extensionsDict.get(packAddress(testExtension))).toEqual(-1n);
        expect((((receipt.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(0);
        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(false);
        expect(await walletV5.getSeqno()).toEqual(seqno);
        const testReceiver = Address.parse('EQAvDfWFG0oYX19jwNDNBBL1rKNT9XfaGP9HyTb5nb2Eml6y');
        const forwardValue = toNano(0.001);
        const receiverBalanceBefore = (await blockchain.getContract(testReceiver)).balance;
        const receipt2 = await walletV5.sendInternalSignedMessage(sender, { value: toNano(0.1), body: createBody(packActionsList([new ActionSendMsg(SendMode.PAY_GAS_SEPARATELY, createMsgInternal({ dest: testReceiver, value: forwardValue }))])) });
        expect((((receipt2.transactions[1].description as TransactionDescriptionGeneric).computePhase as TransactionComputeVm).exitCode)).toEqual(132);
        expect(receipt2.transactions).not.toHaveTransaction({ from: walletV5.address, to: testReceiver, value: forwardValue });
        const receiverBalanceAfter = (await blockchain.getContract(testReceiver)).balance;
        expect(receiverBalanceAfter).toEqual(receiverBalanceBefore);
    });
});
