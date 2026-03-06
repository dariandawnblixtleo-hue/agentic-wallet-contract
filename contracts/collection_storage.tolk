struct NftCollectionStorage {
    adminAddress: address
    content: cell
    nftItemCode: cell
}

fun NftCollectionStorage.load() {
    return NftCollectionStorage.fromCell(contract.getData())
}

fun NftCollectionStorage.save(self) {
    contract.setData(self.toCell())
}
