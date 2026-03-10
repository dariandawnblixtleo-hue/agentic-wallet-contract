import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractABI,
    contractAddress,
    ContractProvider,
    Dictionary,
    internal,
    Sender,
    SendMode,
} from '@ton/core';

const OP_ADD_EXTENSION = 0x02;
const OP_REMOVE_EXTENSION = 0x03;
const OP_SET_SIGNATURE_ALLOWED = 0x04;
const OP_EXTENSION_ACTION_REQUEST = 0xed84cbf0;
const OP_DEPLOY_WALLET = 0x0609e47b;
const OP_INTERNAL_SIGNED_REQUEST = 0x4a3ca895;
const OP_EXTERNAL_SIGNED_REQUEST = 0xbf235204;
const OP_CHANGE_OPERATOR = 0xea4e36cf;
const OP_CHANGE_NFT_CONTENT = 0x1a0b9d51;
const OP_PROVE_OWNERSHIP = 0x04ded148;
const OP_REQUEST_OWNER = 0xd0c3bfea;
const OP_OWNERSHIP_PROOF = 0x0524c7ae;
const OP_OWNER_INFO = 0x0dd607e3;
const OP_OWNERSHIP_PROOF_BOUNCED = 0xc18e86d2;

export type WalletRuntimeData = {
    ownerAddress: Address;
    nftItemContent?: Cell | null;
    originOperatorPublicKey: bigint;
    operatorPublicKey: bigint;
    deployedByUser?: boolean;
};

export type WalletIndexSeed = {
    ownerAddress: Address;
    originOperatorPublicKey: bigint;
    deployedByUser?: boolean;
};

export type AgenticWalletConfig = {
    nftItemIndex: bigint;
    collectionAddress: Address;
};

export type DeployWalletMessage = {
    queryId: bigint;
    walletData: WalletRuntimeData | Cell;
    senderOriginOperatorPublicKey?: bigint;
};

export type ExtensionActionRequest = {
    queryId: bigint;
    outActions?: Cell | null;
    hasExtraActions?: boolean;
    extraActions?: Cell | null;
};

export type InternalSignedRequest = {
    walletNftIndex: bigint;
    validUntil: number;
    seqno: number;
    outActions?: Cell | null;
    extraActions?: Cell | null;
    signature: Buffer;
};

export type ExternalSignedRequest = {
    walletNftIndex: bigint;
    validUntil: number;
    seqno: number;
    outActions?: Cell | null;
    extraActions?: Cell | null;
    signature: Buffer;
};

export type AgenticWalletNftData = {
    isInitialized: boolean;
    nftItemIndex: bigint;
    collectionAddress: Address;
    ownerAddress: Address | null;
    nftItemContent: Cell | null;
};

export type ProveOwnershipMessage = {
    queryId: bigint;
    dest: Address;
    forwardPayload: Cell;
    withContent: boolean;
};

export type RequestOwnerMessage = {
    queryId: bigint;
    dest: Address;
    forwardPayload: Cell;
    withContent: boolean;
};

function emptyExtensionsDict() {
    return Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Bool());
}

export function walletRuntimeDataToCell(data: WalletRuntimeData): Cell {
    return beginCell()
        .storeAddress(data.ownerAddress)
        .storeMaybeRef(data.nftItemContent ?? null)
        .storeUint(data.originOperatorPublicKey, 256)
        .storeUint(data.operatorPublicKey, 256)
        .storeBit(data.deployedByUser ?? true)
        .endCell();
}

function emptyExtraActionsCell() {
    return beginCell().endCell();
}

function buildSnakeCell(head: Cell, tail: Cell | null) {
    const builder = beginCell().storeSlice(head.beginParse());
    if (tail) {
        builder.storeRef(tail);
    }
    return builder.endCell();
}

function isEmptyCell(cell: Cell) {
    const slice = cell.beginParse();
    return slice.remainingBits === 0 && slice.remainingRefs === 0;
}

function ensureSignature(signature: Buffer) {
    if (signature.length !== 64) {
        throw new Error(`Invalid signature length: ${signature.length}. Expected 64 bytes`);
    }
}

function resolveWalletDataCell(src: WalletRuntimeData | Cell): Cell {
    return src instanceof Cell ? src : walletRuntimeDataToCell(src);
}

function resolveExtensionExtraActions(hasExtraActions?: boolean, extraActions?: Cell | null) {
    const cell = extraActions ?? emptyExtraActionsCell();
    return {
        hasExtraActions: hasExtraActions ?? !isEmptyCell(cell),
        extraActions: cell,
    };
}

function appendSignature(bodyWithoutSignature: Cell, signature: Buffer): Cell {
    ensureSignature(signature);
    return beginCell().storeSlice(bodyWithoutSignature.beginParse()).storeBuffer(signature).endCell();
}

function storeSignedRequestPrefix(
    builder: ReturnType<typeof beginCell>,
    opcode: number,
    walletNftIndex: bigint,
    validUntil: number,
    seqno: number,
) {
    return builder
        .storeUint(opcode, 32)
        .storeUint(walletNftIndex, 256)
        .storeUint(validUntil, 32)
        .storeUint(seqno, 32);
}

function storeActionSection(
    builder: ReturnType<typeof beginCell>,
    outActions: Cell | null | undefined,
    hasExtraActions?: boolean,
    extraActions?: Cell | null,
) {
    const extra = resolveExtensionExtraActions(hasExtraActions, extraActions);
    return builder
        .storeMaybeRef(outActions ?? null)
        .storeBit(extra.hasExtraActions)
        .storeSlice(extra.extraActions.beginParse());
}

function storeSignedActionSection(
    builder: ReturnType<typeof beginCell>,
    outActions: Cell | null | undefined,
    extraActions?: Cell | null,
) {
    return builder
        .storeMaybeRef(outActions ?? null)
        .storeMaybeRef(extraActions ?? null);
}

function createSignedRequestBody(
    opcode: number,
    request: Omit<ExternalSignedRequest, 'signature'> | Omit<InternalSignedRequest, 'signature'>,
): Cell {
    return storeSignedActionSection(
        storeSignedRequestPrefix(beginCell(), opcode, request.walletNftIndex, request.validUntil, request.seqno),
        request.outActions,
        request.extraActions,
    ).endCell();
}

export function addressHash(address: Address): bigint {
    return BigInt(`0x${address.hash.toString('hex')}`);
}

export function bufferToUint256(src: Buffer): bigint {
    if (src.length !== 32) {
        throw new Error(`Invalid key length: ${src.length}. Expected 32 bytes`);
    }
    return BigInt(`0x${src.toString('hex')}`);
}

export function walletIndexSeedToCell(seed: WalletIndexSeed): Cell {
    return beginCell().storeAddress(seed.ownerAddress).storeUint(seed.originOperatorPublicKey, 256).storeBit(seed.deployedByUser ?? true).endCell();
}

export function calculateWalletIndex(ownerAddress: Address, originOperatorPublicKey: bigint, deployedByUser = true): bigint {
    return BigInt(`0x${walletIndexSeedToCell({ ownerAddress, originOperatorPublicKey, deployedByUser }).hash().toString('hex')}`);
}

export function agenticWalletConfigToCell(config: AgenticWalletConfig): Cell {
    return beginCell()
        .storeUint(config.nftItemIndex, 256)
        .storeAddress(config.collectionAddress)
        .storeBit(true)
        .storeUint(0, 32)
        .storeDict(null)
        .storeMaybeRef(null)
        .endCell();
}

export function createAddExtensionExtraAction(address: Address): Cell {
    return beginCell().storeUint(OP_ADD_EXTENSION, 8).storeAddress(address).endCell();
}

export function createRemoveExtensionExtraAction(address: Address): Cell {
    return beginCell().storeUint(OP_REMOVE_EXTENSION, 8).storeAddress(address).endCell();
}

export function createSetSignatureAllowedExtraAction(allowSignature: boolean): Cell {
    return beginCell().storeUint(OP_SET_SIGNATURE_ALLOWED, 8).storeBit(allowSignature).endCell();
}

export function createSnakedExtraActions(actions: Cell[]): Cell {
    let next: Cell | null = null;
    for (let i = actions.length - 1; i >= 0; i -= 1) {
        next = buildSnakeCell(actions[i], next);
    }
    return next ?? emptyExtraActionsCell();
}

export function createDeployWalletBody(message: DeployWalletMessage): Cell {
    return beginCell()
        .storeUint(OP_DEPLOY_WALLET, 32)
        .storeUint(message.queryId, 64)
        .storeRef(resolveWalletDataCell(message.walletData))
        .storeUint(message.senderOriginOperatorPublicKey ?? 0n, 256)
        .endCell();
}

export function createChangeOperatorBody(queryId: bigint, newOperatorPublicKey: bigint): Cell {
    return beginCell().storeUint(OP_CHANGE_OPERATOR, 32).storeUint(queryId, 64).storeUint(newOperatorPublicKey, 256).endCell();
}

export function createChangeNftContentBody(queryId: bigint, newNftItemContent: Cell | null): Cell {
    return beginCell().storeUint(OP_CHANGE_NFT_CONTENT, 32).storeUint(queryId, 64).storeMaybeRef(newNftItemContent).endCell();
}

export function createProveOwnershipBody(message: ProveOwnershipMessage): Cell {
    return beginCell()
        .storeUint(OP_PROVE_OWNERSHIP, 32)
        .storeUint(message.queryId, 64)
        .storeAddress(message.dest)
        .storeRef(message.forwardPayload)
        .storeBit(message.withContent)
        .endCell();
}

export function createRequestOwnerBody(message: RequestOwnerMessage): Cell {
    return beginCell()
        .storeUint(OP_REQUEST_OWNER, 32)
        .storeUint(message.queryId, 64)
        .storeAddress(message.dest)
        .storeRef(message.forwardPayload)
        .storeBit(message.withContent)
        .endCell();
}

export function parseOwnershipProof(body: Cell) {
    const cs = body.beginParse();
    const op = cs.loadUint(32);
    if (op !== OP_OWNERSHIP_PROOF) {
        throw new Error(`Expected ownership_proof opcode 0x${OP_OWNERSHIP_PROOF.toString(16)}, got 0x${op.toString(16)}`);
    }
    return {
        queryId: cs.loadUintBig(64),
        itemId: cs.loadUintBig(256),
        owner: cs.loadAddress(),
        data: cs.loadRef(),
        revokedAt: cs.loadUintBig(64),
        content: cs.loadMaybeRef(),
    };
}

export function parseOwnerInfo(body: Cell) {
    const cs = body.beginParse();
    const op = cs.loadUint(32);
    if (op !== OP_OWNER_INFO) {
        throw new Error(`Expected owner_info opcode 0x${OP_OWNER_INFO.toString(16)}, got 0x${op.toString(16)}`);
    }
    return {
        queryId: cs.loadUintBig(64),
        itemId: cs.loadUintBig(256),
        initiator: cs.loadAddress(),
        owner: cs.loadAddress(),
        data: cs.loadRef(),
        revokedAt: cs.loadUintBig(64),
        content: cs.loadMaybeRef(),
    };
}

export function parseOwnershipProofBounced(body: Cell) {
    const cs = body.beginParse();
    const op = cs.loadUint(32);
    if (op !== OP_OWNERSHIP_PROOF_BOUNCED) {
        throw new Error(`Expected ownership_proof_bounced opcode 0x${OP_OWNERSHIP_PROOF_BOUNCED.toString(16)}, got 0x${op.toString(16)}`);
    }
    return {
        queryId: cs.loadUintBig(64),
    };
}

export function createExtensionActionRequestBody(request: ExtensionActionRequest): Cell {
    return storeActionSection(
        beginCell()
            .storeUint(OP_EXTENSION_ACTION_REQUEST, 32)
            .storeUint(request.queryId, 64),
        request.outActions,
        request.hasExtraActions,
        request.extraActions,
    ).endCell();
}

export function createInternalSignedRequestBodyWithoutSignature(request: Omit<InternalSignedRequest, 'signature'>): Cell {
    return createSignedRequestBody(OP_INTERNAL_SIGNED_REQUEST, request);
}

export function createInternalSignedRequestBody(request: InternalSignedRequest): Cell {
    return appendSignature(createInternalSignedRequestBodyWithoutSignature(request), request.signature);
}

export function createExternalSignedRequestBodyWithoutSignature(request: Omit<ExternalSignedRequest, 'signature'>): Cell {
    return createSignedRequestBody(OP_EXTERNAL_SIGNED_REQUEST, request);
}

export function createExternalSignedRequestBody(request: ExternalSignedRequest): Cell {
    return appendSignature(createExternalSignedRequestBodyWithoutSignature(request), request.signature);
}

export function createInternalMessage(to: Address, value: bigint, body: Cell, init?: { code: Cell; data: Cell }) {
    return internal({
        to,
        value,
        bounce: true,
        body,
        init: init ?? undefined,
    });
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

    async sendDeployWallet(provider: ContractProvider, via: Sender, value: bigint, message: DeployWalletMessage) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createDeployWalletBody(message),
        });
    }

    async sendChangeOperator(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        newOperatorPublicKey: bigint,
    ) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createChangeOperatorBody(queryId, newOperatorPublicKey),
        });
    }

    async sendChangeNftContent(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        newNftItemContent: Cell | null,
    ) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createChangeNftContentBody(queryId, newNftItemContent),
        });
    }

    async sendProveOwnership(provider: ContractProvider, via: Sender, value: bigint, message: ProveOwnershipMessage) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createProveOwnershipBody(message),
        });
    }

    async sendRequestOwner(provider: ContractProvider, via: Sender, value: bigint, message: RequestOwnerMessage) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createRequestOwnerBody(message),
        });
    }

    async sendExtensionActionRequest(provider: ContractProvider, via: Sender, value: bigint, request: ExtensionActionRequest) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createExtensionActionRequestBody(request),
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

    async sendInternal(provider: ContractProvider, via: Sender, opts: Parameters<ContractProvider['internal']>[1]) {
        await provider.internal(via, opts);
    }

    async sendExternal(provider: ContractProvider, body: Cell) {
        await provider.external(body);
    }

    async getSeqno(provider: ContractProvider): Promise<number> {
        const result = await provider.get('seqno', []);
        return result.stack.readNumber();
    }

    async getPublicKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_public_key', []);
        return result.stack.readBigNumber();
    }

    async getOriginPublicKey(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_origin_public_key', []);
        return result.stack.readBigNumber();
    }

    async getSubwalletId(provider: ContractProvider): Promise<bigint> {
        const result = await provider.get('get_subwallet_id', []);
        return result.stack.readBigNumber();
    }

    async getIsSignatureAllowed(provider: ContractProvider): Promise<boolean> {
        const result = await provider.get('is_signature_allowed', []);
        return result.stack.readBoolean();
    }

    async getExtensions(provider: ContractProvider): Promise<Dictionary<bigint, boolean>> {
        const result = await provider.get('get_extensions', []);
        const cell = result.stack.readCellOpt();
        if (!cell) {
            return emptyExtensionsDict();
        }
        return Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.Bool(), cell.beginParse());
    }

    async getExtensionsArray(provider: ContractProvider): Promise<Address[]> {
        return [...(await this.getExtensions(provider)).keys()].map((key) =>
            Address.parseRaw(`${this.address.workChain}:${key.toString(16).padStart(64, '0')}`),
        );
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

    async getAuthorityAddress(provider: ContractProvider): Promise<Address | null> {
        const result = await provider.get('get_authority_address', []);
        return result.stack.readAddressOpt();
    }

    async getRevokedTime(provider: ContractProvider): Promise<number> {
        const result = await provider.get('get_revoked_time', []);
        return result.stack.readNumber();
    }
}
