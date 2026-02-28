type ExtensionsDict = map<uint256, bool>

struct WalletIndexSeed {
    ownerAddress: address
    originOperatorPublicKey: uint256
}

struct WalletRuntimeData {
    ownerAddress: address
    nftItemContent: cell?
    originOperatorPublicKey: uint256
    operatorPublicKey: uint256
}

struct AgenticWalletStorage {
    nftItemIndex: uint256
    collectionAddress: address
    isSignatureAllowed: bool
    seqno: uint32
    extensions: ExtensionsDict
    walletData: Cell<WalletRuntimeData>?
}

fun calcWalletIndex(ownerAddress: address, originOperatorPublicKey: uint256): uint256 {
    return WalletIndexSeed {
        ownerAddress,
        originOperatorPublicKey,
    }.toCell().hash();
}

fun buildEmptyWalletStorage(itemIndex: uint256, collectionAddress: address): AgenticWalletStorage {
    return {
        nftItemIndex: itemIndex,
        collectionAddress,
        isSignatureAllowed: true,
        seqno: 0,
        extensions: createEmptyMap(),
        walletData: null,
    };
}

fun calcWalletAddress(itemIndex: uint256, collectionAddress: address, walletCode: cell): AutoDeployAddress {
    return {
        stateInit: {
            code: walletCode,
            data: buildEmptyWalletStorage(itemIndex, collectionAddress).toCell(),
        }
    };
}

fun AgenticWalletStorage.load() {
    return AgenticWalletStorage.fromCell(contract.getData())
}

fun AgenticWalletStorage.save(self) {
    contract.setData(self.toCell())
}

fun loadWalletData(storage: AgenticWalletStorage): WalletRuntimeData? {
    if (storage.walletData == null) {
        return null;
    }
    return WalletRuntimeData.fromCell(storage.walletData as cell);
}