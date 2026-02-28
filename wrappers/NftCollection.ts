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
    TupleBuilder,
} from '@ton/core';
import { calculateWalletIndex } from './AgenticWallet';

const OP_CHANGE_COLLECTION_ADMIN = 0x00000003;

export type CollectionContent = {
    collectionMetadata: Cell;
    commonContent: Cell | string;
};

export type NftCollectionConfig = {
    adminAddress: Address;
    content: Cell | CollectionContent;
    nftItemCode: Cell;
};

export type NftCollectionData = {
    nextItemIndex: number;
    collectionMetadata: Cell;
    adminAddress: Address;
};

export type RoyaltyParams = {
    numerator: number;
    denominator: number;
    destination: Address | null;
};

function resolveCollectionContentCell(content: Cell | CollectionContent): Cell {
    if (content instanceof Cell) {
        return content;
    }
    const commonContentCell =
        typeof content.commonContent === 'string'
            ? beginCell().storeStringTail(content.commonContent).endCell()
            : content.commonContent;

    return beginCell().storeRef(content.collectionMetadata).storeRef(commonContentCell).endCell();
}

export function nftCollectionConfigToCell(config: NftCollectionConfig): Cell {
    return beginCell()
        .storeAddress(config.adminAddress)
        .storeRef(resolveCollectionContentCell(config.content))
        .storeRef(config.nftItemCode)
        .endCell();
}

export function createChangeCollectionAdminBody(queryId: bigint, newAdminAddress: Address): Cell {
    return beginCell().storeUint(OP_CHANGE_COLLECTION_ADMIN, 32).storeUint(queryId, 64).storeAddress(newAdminAddress).endCell();
}

export class NftCollection implements Contract {
    abi: ContractABI = { name: 'NftCollection' };

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new NftCollection(address);
    }

    static createFromConfig(config: NftCollectionConfig, code: Cell, workchain = 0) {
        const data = nftCollectionConfigToCell(config);
        const init = { code, data };
        return new NftCollection(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint, bounce = false) {
        await provider.internal(via, {
            value,
            bounce,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendChangeCollectionAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        newAdminAddress: Address,
    ) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createChangeCollectionAdminBody(queryId, newAdminAddress),
        });
    }

    async getCollectionData(provider: ContractProvider): Promise<NftCollectionData> {
        const result = await provider.get('get_collection_data', []);
        return {
            nextItemIndex: result.stack.readNumber(),
            collectionMetadata: result.stack.readCell(),
            adminAddress: result.stack.readAddress(),
        };
    }

    async getNftAddressByIndex(provider: ContractProvider, itemIndex: bigint): Promise<Address> {
        const tb = new TupleBuilder();
        tb.writeNumber(itemIndex);
        const result = await provider.get('get_nft_address_by_index', tb.build());
        return result.stack.readAddress();
    }

    async getWalletAddressByOwnerAndOriginKey(
        provider: ContractProvider,
        ownerAddress: Address,
        originOperatorPublicKey: bigint,
    ): Promise<Address> {
        return this.getNftAddressByIndex(provider, calculateWalletIndex(ownerAddress, originOperatorPublicKey));
    }

    async getRoyaltyParams(provider: ContractProvider): Promise<RoyaltyParams> {
        const result = await provider.get('royalty_params', []);
        return {
            numerator: result.stack.readNumber(),
            denominator: result.stack.readNumber(),
            destination: result.stack.readAddressOpt(),
        };
    }

    async getNftContent(provider: ContractProvider, itemIndex: bigint, individualNftContent: Cell): Promise<Cell> {
        const tb = new TupleBuilder();
        tb.writeNumber(itemIndex);
        tb.writeCell(individualNftContent);
        const result = await provider.get('get_nft_content', tb.build());
        return result.stack.readCell();
    }
}
