import "errors"
import "collection_storage"
import "messages"
import "wallet_storage"
import "@stdlib/tvm-dicts"


type AllowedMessageToNftCollection = ChangeCollectionAdminMsg | ChangeCollectionContentMsg | ChangeCollectionDataAndCodeMsg;

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToNftCollection.fromSlice(in.body);

    match (msg) {
        ChangeCollectionAdminMsg => {
            var storage = lazy NftCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_INCORRECT_SENDER;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        ChangeCollectionContentMsg => {
            var storage = lazy NftCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_INCORRECT_SENDER;
            storage.content = msg.newContent;
            storage.save();
        }

        ChangeCollectionDataAndCodeMsg => {
            var storage = lazy NftCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_INCORRECT_SENDER;
            contract.setData(msg.newData);
            contract.setCodePostponed(msg.newCode);
        }

        else => {
            assert (in.body.isEmpty()) throw ERROR_UNKNOWN_OPERATION
        }
    }
}

get fun get_collection_data(): (int, cell, address) {
    val storage = lazy NftCollectionStorage.load();

    return (
         -1,
         storage.content,
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

get fun get_nft_content(_itemIndex: int, individual_content: cell): cell {
    var s = individual_content.beginParse();
    if (s.loadUint(8) != 0) {
        return individual_content;
    }
    var contentDict = s.loadDict();
    val imageKey = stringSha256("image");
    if (contentDict.uDictHasKey(256, imageKey)) {
        return individual_content;
    }
    val imageValue = beginCell().storeUint(0, 8).storeSlice("https://agents.ton.org/nft-image.png").endCell();
    contentDict.uDictSetRef(256, stringSha256("image"), imageValue);
    return beginCell().storeUint(0, 8).storeDict(contentDict).endCell();
}
