import "errors"
import "collection_storage"
import "messages"
import "wallet_storage"

const ERROR_UNKNOWN_OPERATION = 0xffff

fun calcNftAddress(itemIndex: uint256, collectionAddress: address, nftItemCode: cell): AutoDeployAddress {
    val emptyNftItemStorage: NftItemStorage = {
        nftItemIndex: itemIndex,
        collectionAddress: collectionAddress,
        walletData: null,
        agentDisabled: false,
        seqno: 0,
    };

    return {
        stateInit: {
            code: nftItemCode,
            data: emptyNftItemStorage.toCell()
        }
    }
}

type AllowedMessageToNftCollection =
    | RequestDeployNftMsg
    | ChangeCollectionAdminMsg

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessageToNftCollection.fromSlice(in.body);

    match (msg) {
        // Standard deployment flow.
        RequestDeployNftMsg => {
            var storage = lazy NftCollectionStorage.load();
            val signature = msg.userSignature;
            val initParamsCell = msg.initParams;
            val nftItemIndex = initParamsCell.hash();
            val agenticWalletData = lazy msg.initParams.load();

            // Deploy only wallets explicitly authorized by the owner.
            assert (isSignatureValid(initParamsCell.hash(), signature as slice, agenticWalletData.masterPublicKey)) throw ERROR_INVALID_SIGNATURE;

            val nftAddress = calcNftAddress(nftItemIndex, contract.getAddress(), storage.nftItemCode);
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: nftAddress,
                body: DeployNftMsg {
                    queryId: msg.queryId,
                    agenticWalletData: msg.initParams,
                }
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);  // Forward all TON to fund the new wallet.
        }

        // TODO: deployment via jetton transfer

        // TODO: admin commands (update NFT code, update collection code)

        ChangeCollectionAdminMsg => {
            var storage = lazy NftCollectionStorage.load();
            assert (in.senderAddress == storage.adminAddress) throw ERROR_INCORRECT_SENDER;
            storage.adminAddress = msg.newAdminAddress;
            storage.save();
        }

        else => {
            // Ignore empty messages, reject unknown opcodes.
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
    val nftDeployed = calcNftAddress(itemIndex, contract.getAddress(), storage.nftItemCode);
    return nftDeployed.calculateAddress();
}

get fun royalty_params(): (int, int, address) {
    return (0, 0, createAddressNone() as address);
}

get fun get_nft_content(itemIndex: int, individualNftContent: Cell<SnakeString>): Cell<OffchainMetadataReply> {
    val storage = lazy NftCollectionStorage.load();
    val content = lazy storage.content.load();

    // Construct a response from common and individual metadata.
    return OffchainMetadataReply {
        string: beginCell()
            .storeSlice(content.commonContent.load())   // Assume it's short (no refs).
            .storeRef(individualNftContent)             // First ref for snake-encoded tail.
            .endCell().beginParse()
    }.toCell()
}
