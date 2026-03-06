import { beginCell, Cell, Dictionary } from '@ton/core';
import { sha256_sync } from '@ton/crypto';

export const ONCHAIN_CONTENT_PREFIX = 0x00;
export const SNAKE_CONTENT_PREFIX = 0x00;

export type OnchainMetadataValue = string | number | bigint | Cell;
export type OnchainMetadata = Record<string, OnchainMetadataValue>;

export function onchainMetadataKey(key: string): bigint {
    return BigInt(`0x${sha256_sync(key).toString('hex')}`);
}

export function buildOnchainMetadataValue(value: OnchainMetadataValue): Cell {
    if (value instanceof Cell) {
        return value;
    }

    const stringValue = typeof value === 'number' || typeof value === 'bigint' ? value.toString() : value;
    return beginCell().storeUint(SNAKE_CONTENT_PREFIX, 8).storeStringTail(stringValue).endCell();
}

export function buildMetadataDict(data: OnchainMetadata): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [key, value] of Object.entries(data)) {
        dict.set(onchainMetadataKey(key), buildOnchainMetadataValue(value));
    }
    return beginCell().storeDictDirect(dict).endCell()
}

export function buildOnchainMetadata(data: OnchainMetadata): Cell {
    return beginCell().storeUint(ONCHAIN_CONTENT_PREFIX, 8).storeMaybeRef(buildMetadataDict(data)).endCell();
}
