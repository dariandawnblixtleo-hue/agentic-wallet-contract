import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import {
    AgenticWallet,
    AgenticWalletData,
    bufferToUint256,
    createExternalSignedRequestBodyWithoutSignature,
    createSetAgentStateExternalBodyWithoutSignature,
} from '../wrappers/AgenticWallet';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';

describe('AgenticWallet', () => {
    let walletCode: Cell;

    beforeAll(async () => {
        walletCode = await compile('AgenticWallet');
    });

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let agenticWallet: SandboxContract<AgenticWallet>;
    let walletData: AgenticWalletData;
    let agentKeys: { publicKey: Buffer; secretKey: Buffer };
    let masterKeys: { publicKey: Buffer; secretKey: Buffer };

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        collection = await blockchain.treasury('collection');
        stranger = await blockchain.treasury('stranger');

        masterKeys = keyPairFromSeed(Buffer.alloc(32, 1));
        agentKeys = keyPairFromSeed(Buffer.alloc(32, 2));
        walletData = {
            subwalletId: 0x12345678,
            agentPublicKey: bufferToUint256(agentKeys.publicKey),
            masterPublicKey: bufferToUint256(masterKeys.publicKey),
            masterWalletAddress: owner.address,
            nftItemContent: null,
        };

        agenticWallet = blockchain.openContract(
            AgenticWallet.createFromConfig(
                {
                    nftItemIndex: 1n,
                    collectionAddress: collection.address,
                    agentDisabled: false,
                    seqno: 0,
                    walletData,
                },
                walletCode,
            ),
        );

        const deployResult = await agenticWallet.sendDeploy(owner.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: agenticWallet.address,
            deploy: true,
            success: true,
        });
    });

    it('exposes expected getters after deploy', async () => {
        expect(await agenticWallet.getSeqno()).toBe(0);
        expect(await agenticWallet.getSubwalletId()).toBe(walletData.subwalletId);
        expect(await agenticWallet.getPublicKey()).toBe(walletData.masterPublicKey);

        const nftData = await agenticWallet.getNftData();
        expect(nftData.isInitialized).toBe(true);
        expect(nftData.nftItemIndex).toBe(1n);
        expect(nftData.collectionAddress.equals(collection.address)).toBe(true);
        expect(nftData.ownerAddress?.equals(owner.address)).toBe(true);
    });

    it('supports external state toggle and enforces agent-disabled signature checks', async () => {
        const validUntil = Math.floor(Date.now() / 1000) + 3600;
        const disableSignable = createSetAgentStateExternalBodyWithoutSignature({
            walletId: walletData.subwalletId,
            validUntil,
            seqno: 0,
            agentDisabled: true,
        });
        const disableSignature = sign(disableSignable.hash(), masterKeys.secretKey);

        const disableResult = await agenticWallet.sendSetAgentStateExternal({
            walletId: walletData.subwalletId,
            validUntil,
            seqno: 0,
            agentDisabled: true,
            signature: disableSignature,
        });
        expect(disableResult.transactions).toHaveTransaction({
            on: agenticWallet.address,
            success: true,
        });
        expect(await agenticWallet.getSeqno()).toBe(1);

        const agentSignable = createExternalSignedRequestBodyWithoutSignature({
            walletId: walletData.subwalletId,
            validUntil,
            seqno: 1,
            outActions: null,
        });
        const agentSignature = sign(agentSignable.hash(), agentKeys.secretKey);

        await expect(
            agenticWallet.sendExternalSignedRequest({
                walletId: walletData.subwalletId,
                validUntil,
                seqno: 1,
                outActions: null,
                signature: agentSignature,
            }),
        ).rejects.toThrow('Exit code: 135');
        expect(await agenticWallet.getSeqno()).toBe(1);

        const ownerSignature = sign(agentSignable.hash(), masterKeys.secretKey);
        const ownerResult = await agenticWallet.sendExternalSignedRequest({
            walletId: walletData.subwalletId,
            validUntil,
            seqno: 1,
            outActions: null,
            signature: ownerSignature,
        });
        expect(ownerResult.transactions).toHaveTransaction({
            on: agenticWallet.address,
            success: true,
        });
        expect(await agenticWallet.getSeqno()).toBe(2);
    });

    it('updates agent key and rejects old agent signatures', async () => {
        const newAgentKeys = keyPairFromSeed(Buffer.alloc(32, 3));

        const forbidden = await agenticWallet.sendChangeKeypair(
            stranger.getSender(),
            toNano('0.05'),
            10n,
            bufferToUint256(newAgentKeys.publicKey),
        );
        expect(forbidden.transactions).toHaveTransaction({
            from: stranger.address,
            to: agenticWallet.address,
            exitCode: 50,
            success: false,
        });

        const changed = await agenticWallet.sendChangeKeypair(
            owner.getSender(),
            toNano('0.05'),
            11n,
            bufferToUint256(newAgentKeys.publicKey),
        );
        expect(changed.transactions).toHaveTransaction({
            from: owner.address,
            to: agenticWallet.address,
            success: true,
        });

        const validUntil = Math.floor(Date.now() / 1000) + 3600;
        const signable = createExternalSignedRequestBodyWithoutSignature({
            walletId: walletData.subwalletId,
            validUntil,
            seqno: 0,
            outActions: null,
        });

        const oldSignature = sign(signable.hash(), agentKeys.secretKey);
        await expect(
            agenticWallet.sendExternalSignedRequest({
                walletId: walletData.subwalletId,
                validUntil,
                seqno: 0,
                outActions: null,
                signature: oldSignature,
            }),
        ).rejects.toThrow('Exit code: 135');

        const newSignature = sign(signable.hash(), newAgentKeys.secretKey);
        const newSignatureResult = await agenticWallet.sendExternalSignedRequest({
            walletId: walletData.subwalletId,
            validUntil,
            seqno: 0,
            outActions: null,
            signature: newSignature,
        });
        expect(newSignatureResult.transactions).toHaveTransaction({
            on: agenticWallet.address,
            success: true,
        });
        expect(await agenticWallet.getSeqno()).toBe(1);
    });
});
