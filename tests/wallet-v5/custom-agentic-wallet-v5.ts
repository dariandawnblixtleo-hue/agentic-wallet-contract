import {
    Address,
    beginCell,
    BitReader,
    BitString,
    Builder,
    Cell,
    Contract,
    ContractABI,
    ContractProvider,
    contractAddress,
    Dictionary,
    MessageRelaxed,
    OutAction,
    OutActionSendMsg,
    Sender,
    SendMode,
    Slice,
    storeOutList,
    toNano,
} from '@ton/core';
import { sign } from '@ton/crypto';
import { AgenticWallet, WalletRuntimeData } from '../../wrappers/AgenticWallet';

export const Opcodes = {
    action_send_msg: 0x0ec3c86d,
    action_set_code: 0xad4de08e,
    action_extended_set_data: 0x1ff8ea0b,
    action_extended_add_extension: 0x02,
    action_extended_remove_extension: 0x03,
    action_extended_set_signature_auth_allowed: 0x04,
    auth_extension: 0xed84cbf0,
    auth_signed: 0xbf235204,
    auth_signed_internal: 0x4a3ca895
};

export type TestWallet = AgenticWalletV5Test;

export type WalletActions = {
    wallet?: OutAction[] | Cell;
    extended?: ExtendedAction[] | Cell;
};

export type ExtensionAdd = {
    type: 'add_extension';
    address: Address;
};

export type ExtensionRemove = {
    type: 'remove_extension';
    address: Address;
};

export type SetSignatureAuth = {
    type: 'sig_auth';
    allowed: boolean;
};

export type ExtendedAction = ExtensionAdd | ExtensionRemove | SetSignatureAuth;

export type MessageOut = {
    message: MessageRelaxed;
    mode: SendMode;
};

export interface WalletIdV5R1<
    C extends WalletIdV5R1ClientContext | WalletIdV5R1CustomContext =
        | WalletIdV5R1ClientContext
        | WalletIdV5R1CustomContext
> {
    readonly networkGlobalId: number;
    readonly context: C;
}

export interface WalletIdV5R1ClientContext {
    readonly walletVersion: 'v5r1';
    readonly workchain: number;
    readonly subwalletNumber: number;
}

export type WalletIdV5R1CustomContext = number;

const walletV5R1VersionsSerialisation: Record<WalletIdV5R1ClientContext['walletVersion'], number> = {
    v5r1: 0,
};

function isWalletIdV5R1ClientContext(
    context: WalletIdV5R1ClientContext | WalletIdV5R1CustomContext
): context is WalletIdV5R1ClientContext {
    return typeof context !== 'number';
}

export function storeWalletIdV5R1(walletId: WalletIdV5R1) {
    return (builder: Builder) => {
        let context;
        if (isWalletIdV5R1ClientContext(walletId.context)) {
            context = beginCell()
                .storeUint(1, 1)
                .storeInt(walletId.context.workchain, 8)
                .storeUint(walletV5R1VersionsSerialisation[walletId.context.walletVersion], 8)
                .storeUint(walletId.context.subwalletNumber, 15)
                .endCell()
                .beginParse()
                .loadInt(32);
        } else {
            context = beginCell()
                .storeUint(0, 1)
                .storeUint(walletId.context, 31)
                .endCell()
                .beginParse()
                .loadInt(32);
        }

        return builder.storeInt(BigInt(walletId.networkGlobalId) ^ BigInt(context), 32);
    };
}

function loadWalletIdV5R1(value: bigint | Buffer | Slice, networkGlobalId: number) {
    const val = new BitReader(
        new BitString(
            typeof value === 'bigint'
                ? Buffer.from(value.toString(16).padStart(8, '0'), 'hex')
                : value instanceof Slice
                  ? value.loadBuffer(4)
                  : value,
            0,
            32
        )
    ).loadInt(32);

    const context = BigInt(val) ^ BigInt(networkGlobalId);
    const bitReader = beginCell().storeInt(context, 32).endCell().beginParse();
    const isClientContext = bitReader.loadUint(1);
    if (isClientContext) {
        const workchain = bitReader.loadInt(8);
        const walletVersionRaw = bitReader.loadUint(8);
        const subwalletNumber = bitReader.loadUint(15);
        const walletVersion = Object.entries(walletV5R1VersionsSerialisation).find(
            ([, ser]) => ser === walletVersionRaw
        );
        if (!walletVersion) {
            throw new Error(`Can't deserialize walletId: unknown wallet version ${walletVersionRaw}`);
        }
        return {
            networkGlobalId,
            context: {
                walletVersion: walletVersion[0] as WalletIdV5R1ClientContext['walletVersion'],
                workchain,
                subwalletNumber,
            },
        };
    }
    throw new Error('Non-client context is not implemented');
}

function storeExtensionAction(action: ExtendedAction) {
    return (builder: Builder) => {
        if (action.type === 'add_extension') {
            builder.storeUint(2, 8).storeAddress(action.address);
        } else if (action.type === 'remove_extension') {
            builder.storeUint(3, 8).storeAddress(action.address);
        } else {
            builder.storeUint(4, 8).storeBit(action.allowed);
        }
    };
}

export function storeExtendedActions(actions: ExtendedAction[]) {
    const cell = actions.slice().reverse().reduce((curCell, action) => {
        const ds = beginCell().store(storeExtensionAction(action));
        if (curCell.bits.length > 0) {
            ds.storeRef(curCell);
        }
        return ds.endCell();
    }, beginCell().endCell());
    return (builder: Builder) => builder.storeSlice(cell.beginParse());
}

function storeWalletActions(actions: WalletActions) {
    return (builder: Builder) => {
        if (actions.wallet) {
            let actionCell: Cell | null = null;
            if (actions.wallet instanceof Cell) {
                actionCell = actions.wallet;
            } else if (actions.wallet.length > 0) {
                actionCell = beginCell().store(storeOutList(actions.wallet)).endCell();
            }
            builder.storeMaybeRef(actionCell);
        } else {
            builder.storeBit(false);
        }

        if (actions.extended) {
            if (actions.extended instanceof Cell) {
                builder.storeBit(true);
                builder.storeSlice(actions.extended.asSlice());
            } else if (actions.extended.length > 0) {
                builder.storeBit(true);
                builder.store(storeExtendedActions(actions.extended));
            } else {
                builder.storeBit(false);
            }
        } else {
            builder.storeBit(false);
        }
    };
}

function randomAddress(wc = 0) {
    const buf = Buffer.alloc(32);
    for (let i = 0; i < buf.length; i++) {
        buf[i] = Math.floor(Math.random() * 256);
    }
    return new Address(wc, buf);
}

function walletIdToNftIndex(walletId: WalletIdV5R1 | bigint | number): bigint {
    if (typeof walletId === 'bigint') {
        return walletId;
    }
    if (typeof walletId === 'number') {
        return BigInt(walletId);
    }
    // CUSTOM: compatibility mode stores serialized wallet-v5 id in uint256 nft index.
    const tmp = beginCell().store(storeWalletIdV5R1(walletId)).endCell().beginParse().loadIntBig(32);
    return BigInt.asUintN(32, tmp);
}

export type WalletV5Config = {
    signatureAllowed: boolean;
    seqno: number;
    walletId: WalletIdV5R1 | bigint | number;
    publicKey: Buffer;
    extensions: Dictionary<bigint, bigint>;
    ownerAddress?: Address;
    collectionAddress?: Address;
};

function runtimeDataCellFromConfig(config: WalletV5Config, workchain = 0): Cell {
    const ownerAddress = config.ownerAddress ?? randomAddress(workchain); // CUSTOM
    const pk = BigInt(`0x${config.publicKey.toString('hex')}`);
    return beginCell()
        .storeAddress(ownerAddress)
        .storeMaybeRef(null)
        .storeUint(pk, 256)
        .storeUint(pk, 256)
        .storeBit(true)
        .endCell();
}

function splitWalletV5PackedActions(actionsList: Cell) {
    const slice = actionsList.beginParse();
    const outActions = slice.loadMaybeRef();
    const hasExtendedActions = slice.loadBit();

    return {
        outActions,
        // CUSTOM: signed AgenticWallet requests store extra actions as maybe-ref, while extension requests keep original inline format.
        extraActions: hasExtendedActions ? beginCell().storeSlice(slice).endCell() : null,
    };
}

export class AgenticWalletV5Test implements Contract {
    abi: ContractABI = { name: 'AgenticWalletV5Test' };

    // CUSTOM: thin test adapter over AgenticWallet to keep wallet-contract-v5 test style.
    constructor(readonly inner: AgenticWallet) {}

    static createFromConfig(config: WalletV5Config, code: Cell, workchain = 0) {
        const nftItemIndex = walletIdToNftIndex(config.walletId);
        const collectionAddress = config.collectionAddress ?? randomAddress(workchain);

        const extBool = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Bool());
        for (const key of config.extensions.keys()) {
            extBool.set(key, true);
        }

        const data = beginCell()
            .storeUint(nftItemIndex, 256)
            .storeAddress(collectionAddress)
            .storeBit(config.signatureAllowed)
            .storeUint(config.seqno, 32)
            .storeDict(extBool, Dictionary.Keys.BigUint(256), Dictionary.Values.Bool())
            .storeMaybeRef(runtimeDataCellFromConfig(config, workchain))
            .endCell();

        const init = { code, data };
        return new AgenticWalletV5Test(new AgenticWallet(contractAddress(workchain, init), init));
    }

    get address() {
        return this.inner.address;
    }

    get init() {
        return this.inner.init;
    }

    async sendDeployWallet(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        message: {
            queryId: bigint;
            walletData: WalletRuntimeData | Cell;
            senderOriginOperatorPublicKey?: bigint;
        }
    ) {
        // CUSTOM: expose AgenticWallet deploy entrypoint under the wallet-v5-style opened-contract wrapper.
        await this.inner.sendDeployWallet(provider, via, value, message);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    static requestMessage(
        internal: boolean,
        wallet_id: number | bigint,
        valid_until: number,
        seqno: bigint | number,
        actions: WalletActions,
        key?: Buffer
    ) {
        const op = internal ? Opcodes.auth_signed_internal : Opcodes.auth_signed;
        const actionsList = beginCell().store(storeWalletActions(actions)).endCell();
        const msgBody = createUnsignedBodyForAgenticWallet({
            authOpcode: op,
            actionsList,
            walletId: BigInt(wallet_id),
            seqno: Number(seqno),
            validUntil: valid_until,
        });
        return key ? AgenticWalletV5Test.signRequestMessage(msgBody, key) : msgBody;
    }

    static signRequestMessage(msg: Cell, key: Buffer) {
        const signature = sign(msg.hash(), key);
        return beginCell().storeSlice(msg.asSlice()).storeBuffer(signature).endCell();
    }

    static extensionMessage(actions: WalletActions, query_id: bigint | number = 0) {
        return beginCell()
            .storeUint(Opcodes.auth_extension, 32)
            .storeUint(query_id, 64)
            .store(storeWalletActions(actions))
            .endCell();
    }

    async sendMessagesExternal(
        provider: ContractProvider,
        wallet_id: number | bigint,
        valid_until: number,
        seqno: bigint | number,
        key: Buffer,
        messages: MessageOut[]
    ) {
        const actions: OutActionSendMsg[] = messages.map(message2action);
        await provider.external(
            AgenticWalletV5Test.requestMessage(
                false,
                wallet_id,
                valid_until,
                seqno,
                { wallet: actions },
                key
            )
        );
    }

    async sendExtensionActions(
        provider: ContractProvider,
        via: Sender,
        actions: WalletActions,
        value: bigint = toNano('0.1'),
        query_id: bigint | number = 0
    ) {
        await provider.internal(via, {
            value,
            body: AgenticWalletV5Test.extensionMessage(actions, query_id),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
    }

    async sendMessagesInternal(
        provider: ContractProvider,
        via: Sender,
        wallet_id: number | bigint,
        valid_until: number,
        seqno: bigint | number,
        key: Buffer,
        messages: MessageOut[],
        value: bigint = toNano('0.05')
    ) {
        const actions: OutActionSendMsg[] = messages.map(message2action);
        await provider.internal(via, {
            value,
            body: AgenticWalletV5Test.requestMessage(
                true,
                wallet_id,
                valid_until,
                seqno,
                { wallet: actions },
                key
            ),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
    }

    async sendInternalSignedMessage(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            body: Cell;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeSlice(opts.body.beginParse()).endCell()
        });
    }

    async send(provider: ContractProvider, body: Cell) {
        // CUSTOM: wallet-v5 `send(...)` external helper is mapped to AgenticWallet external signed entrypoint.
        await provider.external(body);
    }

    async sendExternalSignedMessage(provider: ContractProvider, body: Cell) {
        await provider.external(body);
    }

    async sendInternalMessageFromExtension(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            body: Cell;
            queryId?: bigint | number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            // CUSTOM: extension path in AgenticWallet is still wallet-v5-compatible, so the original wrapper shape is preserved.
            body: beginCell()
                .storeUint(Opcodes.auth_extension, 32)
                .storeUint(opts.queryId ?? 0, 64)
                .storeSlice(opts.body.asSlice())
                .endCell()
        });
    }

    async getWalletId(provider: ContractProvider) {
        const result = await provider.get('get_subwallet_id', []);
        return result.stack.readBigNumber();
    }

    async getWalletIdParsed(provider: ContractProvider, networkId: -239 | -3 = -239) {
        const walletId = await this.getWalletId(provider);
        if (walletId <= 0xffffffffn) {
            return loadWalletIdV5R1(walletId, networkId);
        }
        // CUSTOM: AgenticWallet ids are uint256 hashes; expose a synthetic v5-like context for tests that need only subwalletNumber.
        return {
            networkGlobalId: networkId,
            context: {
                walletVersion: 'v5r1' as const,
                workchain: this.address.workChain,
                subwalletNumber: Number(walletId & 0x7fffn),
            },
        };
    }

    async getExtensions(provider: ContractProvider) {
        const result = await provider.get('get_extensions', []);
        return result.stack.readCellOpt();
    }

    async getIsSecretKeyAuthEnabled(provider: ContractProvider) {
        const result = await provider.get('is_signature_allowed', []);
        return result.stack.readBoolean();
    }

    async getSeqno(provider: ContractProvider) {
        const result = await provider.get('seqno', []);
        return result.stack.readNumber();
    }

    async getPublicKey(provider: ContractProvider) {
        const result = await provider.get('get_public_key', []);
        return result.stack.readBigNumber();
    }

    async getOriginPublicKey(provider: ContractProvider) {
        const result = await provider.get('get_origin_public_key', []);
        return result.stack.readBigNumber();
    }

    async getExtensionsArray(provider: ContractProvider) {
        return await this.inner.getExtensionsArray(provider);
    }

    async getNftData(provider: ContractProvider) {
        return await this.inner.getNftData(provider);
    }
}

export const WalletV5Test = AgenticWalletV5Test;

export function message2action(msg: MessageOut): OutActionSendMsg {
    return {
        type: 'sendMsg',
        mode: msg.mode,
        outMsg: msg.message,
    };
}

export function TestWalletFromV5(wallet: AgenticWalletV5Test) {
    // CUSTOM: identity helper for compatibility with wallet-contract-v5 test style.
    return wallet;
}

function createUnsignedBodyForAgenticWallet(params: {
    authOpcode?: number;
    actionsList: Cell;
    walletId: bigint;
    seqno: number;
    validUntil: number;
}) {
    const { outActions, extraActions } = splitWalletV5PackedActions(params.actionsList);
    return beginCell()
        .storeUint(params.authOpcode ?? Opcodes.auth_signed_internal, 32)
        .storeUint(params.walletId, 256)
        .storeUint(params.validUntil, 32)
        .storeUint(params.seqno, 32)
        .storeMaybeRef(outActions)
        .storeMaybeRef(extraActions)
        .endCell();
}

export function createBodyForAgenticWallet(params: {
    authOpcode?: number;
    actionsList: Cell;
    walletId: bigint;
    seqno: number;
    validUntil: number;
    secretKey: Buffer;
}) {
    const payload = createUnsignedBodyForAgenticWallet({
        authOpcode: params.authOpcode,
        actionsList: params.actionsList,
        walletId: params.walletId,
        seqno: params.seqno,
        validUntil: params.validUntil,
    });
    const signature = sign(payload.hash(), params.secretKey);
    return beginCell()
        .storeSlice(payload.beginParse())
        .storeBuffer(signature)
        .endCell();
}
