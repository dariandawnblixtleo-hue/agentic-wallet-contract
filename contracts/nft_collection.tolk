import "errors"
import "collection_storage"
import "messages"
import "wallet_storage"

const ERROR_UNKNOWN_OPERATION = 0xffff

type AllowedMessageToNftCollection = ChangeCollectionAdminMsg

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToNftCollection.fromSlice(in.body);

    match (msg) {
        ChangeCollectionAdminMsg => {
            var storage = lazy NftCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_INCORRECT_SENDER;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        else => {
            assert (in.body.isEmpty()) throw ERROR_UNKNOWN_OPERATION
        }
    }
}

struct (0x01) OffchainMetadataReply {
    string: SnakeString
}

get fun get_collection_data(): (int, cell, address) {
    val storage = lazy NftCollectionStorage.load();
    val content = lazy storage.content.load();

    return (
         -1,
         content.collectionMetadata,
         storage.adminAddress,
    );
}

get fun get_nft_address_by_index(itemIndex: int): address {
    val storage = lazy NftCollectionStorage.load();
    val walletAddress = calcWalletAddress(itemIndex, contract.getAddress(), storage.nftItemCode);
    return walletAddress.calculateAddress();
}

get fun royalty_params(): (int, int, address) {
    return (0, 0, createAddressNone() as address);
}

get fun get_nft_content(itemIndex: int, individualNftContent: Cell<SnakeString>): Cell<OffchainMetadataReply> {
    val storage = lazy NftCollectionStorage.load();
    val content = lazy storage.content.load();

    return OffchainMetadataReply {
        string: beginCell()
            .storeSlice(content.commonContent.load())
            .storeRef(individualNftContent)
            .endCell().beginParse()
    }.toCell()
}
