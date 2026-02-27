import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractABI,
    contractAddress,
    ContractProvider,
    SendMode,
    Sender,
} from '@ton/core';

const OP_DEPLOY_NFT = 0x0609e47b;
const OP_INTERNAL_SIGNED_REQUEST = 0x73696e74;
const OP_EXTERNAL_SIGNED_REQUEST = 0x7369676e;
const OP_SET_AGENT_STATE_EXTERNAL = 0xf198cc9e;
const OP_CHANGE_KEYPAIR = 0xea4e36cf;

export type AgenticWalletData = {
    subwalletId: number;
    agentPublicKey: bigint;
    masterPublicKey: bigint;
    masterWalletAddress: Address;
    nftItemContent?: Cell | null;
};

export type AgenticWalletConfig = {
    nftItemIndex: bigint;
    collectionAddress: Address;
    agentDisabled?: boolean;
    seqno?: number;
    walletData?: AgenticWalletData | Cell | null;
};

export type DeployNftMessage = {
    queryId: bigint;
    agenticWalletData: AgenticWalletData | Cell;
};

export type InternalSignedRequest = {
    walletId: number;
    validUntil: number;
    seqno: number;
    outActions?: Cell | null;
    signature: Buffer;
};

export type ExternalSignedRequest = {
    walletId: number;
    validUntil: number;
    seqno: number;
    outActions?: Cell | null;
    signature: Buffer;
};

export type SetAgentStateExternalRequest = {
    walletId: number;
    validUntil: number;
    seqno: number;
    agentDisabled: boolean;
    signature: Buffer;
};

export type AgenticWalletNftData = {
    isInitialized: boolean;
    nftItemIndex: bigint;
    collectionAddress: Address;
    ownerAddress: Address | null;
    nftItemContent: Cell | null;
};

function ensureSignature(signature: Buffer) {
    if (signature.length !== 64) {
        throw new Error(`Invalid signature length: ${signature.length}. Expected 64 bytes`);
    }
}

function resolveWalletDataCell(src: AgenticWalletData | Cell): Cell {
    return src instanceof Cell ? src : agenticWalletDataToCell(src);
}

function appendSignature(bodyWithoutSignature: Cell, signature: Buffer): Cell {
    ensureSignature(signature);
    return beginCell().storeSlice(bodyWithoutSignature.beginParse()).storeBuffer(signature).endCell();
}

export function bufferToUint256(src: Buffer): bigint {
    if (src.length !== 32) {
        throw new Error(`Invalid key length: ${src.length}. Expected 32 bytes`);
    }
    return BigInt(`0x${src.toString('hex')}`);
}

export function agenticWalletDataToCell(data: AgenticWalletData): Cell {
    return beginCell()
        .storeUint(data.subwalletId, 32)
        .storeUint(data.agentPublicKey, 256)
        .storeUint(data.masterPublicKey, 256)
        .storeAddress(data.masterWalletAddress)
        .storeMaybeRef(data.nftItemContent ?? null)
        .endCell();
}

export function agenticWalletConfigToCell(config: AgenticWalletConfig): Cell {
    return beginCell()
        .storeUint(config.nftItemIndex, 256)
        .storeAddress(config.collectionAddress)
        .storeBit(config.agentDisabled ?? false)
        .storeUint(config.seqno ?? 0, 32)
        .storeMaybeRef(config.walletData ? resolveWalletDataCell(config.walletData) : null)
        .endCell();
}

export function createDeployNftBody(message: DeployNftMessage): Cell {
    return beginCell()
        .storeUint(OP_DEPLOY_NFT, 32)
        .storeUint(message.queryId, 64)
        .storeRef(resolveWalletDataCell(message.agenticWalletData))
        .endCell();
}

export function createMasterCommandBody(command: string): Cell {
    return beginCell().storeUint(0, 32).storeStringTail(command).endCell();
}

export function createChangeKeypairBody(queryId: bigint, newAgentPublicKey: bigint): Cell {
    return beginCell().storeUint(OP_CHANGE_KEYPAIR, 32).storeUint(queryId, 64).storeUint(newAgentPublicKey, 256).endCell();
}

export function createInternalSignedRequestBodyWithoutSignature(request: Omit<InternalSignedRequest, 'signature'>): Cell {
    return beginCell()
        .storeUint(OP_INTERNAL_SIGNED_REQUEST, 32)
        .storeUint(request.walletId, 32)
        .storeUint(request.validUntil, 32)
        .storeUint(request.seqno, 32)
        .storeMaybeRef(request.outActions ?? null)
        .endCell();
}

export function createInternalSignedRequestBody(request: InternalSignedRequest): Cell {
    const signable = createInternalSignedRequestBodyWithoutSignature(request);
    return appendSignature(signable, request.signature);
}

export function createExternalSignedRequestBodyWithoutSignature(request: Omit<ExternalSignedRequest, 'signature'>): Cell {
    return beginCell()
        .storeUint(OP_EXTERNAL_SIGNED_REQUEST, 32)
        .storeUint(request.walletId, 32)
        .storeUint(request.validUntil, 32)
        .storeUint(request.seqno, 32)
        .storeMaybeRef(request.outActions ?? null)
        .endCell();
}

export function createExternalSignedRequestBody(request: ExternalSignedRequest): Cell {
    const signable = createExternalSignedRequestBodyWithoutSignature(request);
    return appendSignature(signable, request.signature);
}

export function createSetAgentStateExternalBodyWithoutSignature(
    request: Omit<SetAgentStateExternalRequest, 'signature'>,
): Cell {
    return beginCell()
        .storeUint(OP_SET_AGENT_STATE_EXTERNAL, 32)
        .storeUint(request.walletId, 32)
        .storeUint(request.validUntil, 32)
        .storeUint(request.seqno, 32)
        .storeBit(request.agentDisabled)
        .endCell();
}

export function createSetAgentStateExternalBody(request: SetAgentStateExternalRequest): Cell {
    const signable = createSetAgentStateExternalBodyWithoutSignature(request);
    return appendSignature(signable, request.signature);
}

export class AgenticWallet implements Contract {
    abi: ContractABI = { name: 'AgenticWallet' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new AgenticWallet(address);
    }

    static createFromConfig(config: AgenticWalletConfig, code: Cell, workchain = 0) {
        const data = agenticWalletConfigToCell(config);
        const init = { code, data };
        return new AgenticWallet(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint, bounce = false) {
        await provider.internal(via, {
            value,
            bounce,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendDeployNft(provider: ContractProvider, via: Sender, value: bigint, message: DeployNftMessage) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createDeployNftBody(message),
        });
    }

    async sendMasterCommand(provider: ContractProvider, via: Sender, value: bigint, command: string) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createMasterCommandBody(command),
        });
    }

    async sendChangeKeypair(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        newAgentPublicKey: bigint,
    ) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createChangeKeypairBody(queryId, newAgentPublicKey),
        });
    }

    async sendInternalSignedRequest(provider: ContractProvider, via: Sender, value: bigint, request: InternalSignedRequest) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createInternalSignedRequestBody(request),
        });
    }

    async sendExternalSignedRequest(provider: ContractProvider, request: ExternalSignedRequest) {
        await provider.external(createExternalSignedRequestBody(request));
    }

    async sendSetAgentStateExternal(provider: ContractProvider, request: SetAgentStateExternalRequest) {
        await provider.external(createSetAgentStateExternalBody(request));
    }

    async getSeqno(provider: ContractProvider): Promise<number> {
        const result = await provider.get('seqno', []);
        return result.stack.readNumber();
    }

    async getSubwalletId(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_subwallet_id', []);
        return result.stack.readNumber();
    }

    async getPublicKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_public_key', []);
        return result.stack.readBigNumber();
    }

    async getNftData(provider: ContractProvider): Promise<AgenticWalletNftData> {
        const result = await provider.get('get_nft_data', []);
        return {
            isInitialized: result.stack.readBoolean(),
            nftItemIndex: result.stack.readBigNumber(),
            collectionAddress: result.stack.readAddress(),
            ownerAddress: result.stack.readAddressOpt(),
            nftItemContent: result.stack.readCellOpt(),
        };
    }
}
