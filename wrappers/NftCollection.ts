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
export {
    buildOnchainMetadata,
    buildOnchainMetadataValue,
    onchainMetadataKey,
    ONCHAIN_CONTENT_PREFIX,
    SNAKE_CONTENT_PREFIX,
    type OnchainMetadata,
    type OnchainMetadataValue,
} from './buildOnchain';

const OP_CHANGE_COLLECTION_ADMIN = 0x00000003;
const OP_CHANGE_COLLECTION_CONTENT = 0x00000004;
const OP_CHANGE_COLLECTION_DATA_AND_CODE = 0x00000005;

export type CollectionContent = {
    collectionMetadata: Cell;
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
    return content.collectionMetadata;
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

export function createChangeCollectionContentBody(queryId: bigint, newContent: Cell): Cell {
    return beginCell().storeUint(OP_CHANGE_COLLECTION_CONTENT, 32).storeUint(queryId, 64).storeRef(newContent).endCell();
}

export function createChangeCollectionDataAndCodeBody(queryId: bigint, newData: Cell, newCode: Cell): Cell {
    return beginCell().storeUint(OP_CHANGE_COLLECTION_DATA_AND_CODE, 32).storeUint(queryId, 64).storeRef(newData).storeRef(newCode).endCell();
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

    async sendChangeCollectionContent(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        newContent: Cell,
    ) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createChangeCollectionContentBody(queryId, newContent),
        });
    }

    async sendChangeCollectionDataAndCode(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        queryId: bigint,
        newData: Cell,
        newCode: Cell,
    ) {
        await provider.internal(via, {
            value,
            bounce: true,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: createChangeCollectionDataAndCodeBody(queryId, newData, newCode),
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
        deployedByUser = true,
    ): Promise<Address> {
        return this.getNftAddressByIndex(provider, calculateWalletIndex(ownerAddress, originOperatorPublicKey, deployedByUser));
    }

    async getRoyaltyParams(provider: ContractProvider): Promise<RoyaltyParams> {
        const result = await provider.get('royalty_params', []);
        return {
            numerator: result.stack.readNumber(),
            denominator: result.stack.readNumber(),
            destination: result.stack.readAddressOpt(),
        };
    }

    async getNftContent(provider: ContractProvider, itemIndex: bigint, individualNftContent: Cell | null): Promise<Cell> {
        const tb = new TupleBuilder();
        tb.writeNumber(itemIndex);
        tb.writeCell(individualNftContent);
        const result = await provider.get('get_nft_content', tb.build());
        return result.stack.readCell();
    }
}
