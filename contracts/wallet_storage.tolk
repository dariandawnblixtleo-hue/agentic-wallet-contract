struct AgenticWalletData {
    subwalletId: uint32
    agentPublicKey: uint256
    masterPublicKey: uint256
    masterWalletAddress: address
    nftItemContent: cell?
}

struct NftItemStorage {
    nftItemIndex: uint256
    collectionAddress: address
    agentDisabled: bool
    seqno: uint32
    walletData: Cell<AgenticWalletData>?
}

fun NftItemStorage.load() {
    return NftItemStorage.fromCell(contract.getData())
}

fun NftItemStorage.save(self) {
    contract.setData(self.toCell())
}
