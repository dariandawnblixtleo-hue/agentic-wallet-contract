import "@stdlib/gas-payments"
import "errors"
import "wallet_storage"
import "messages"
import "c5-register-validation"
import "agentic_wallet_custom"

const SIZE_SIGNATURE = 512;
const MIN_SIGNED_REQUEST_BITS = 32 + 256 + 32 + 32 + 1 + 1;


@inline_ref
fun processExtraActions(extraActions: SnakedExtraActions, isExtension: bool) {
    while (true) {
        val action = lazy ExtraAction.fromSlice(extraActions);
        match (action) {
            AddExtensionExtraAction => {
                var (extensionWorkchain, extensionAddrHash) = action.addr.getWorkchainAndHash();
                var myWorkchain = contract.getAddress().getWorkchain();
                assert (myWorkchain == extensionWorkchain) throw ERROR_EXTENSION_WRONG_WORKCHAIN;

                var storage = lazy AgenticWalletStorage.load();
                val inserted = storage.extensions.addIfNotExists(extensionAddrHash, true);
                assert (inserted) throw ERROR_ADD_EXTENSION;
                storage.save();
            }

            RemoveExtensionExtraAction => {
                var (extensionWorkchain, extensionAddrHash) = action.addr.getWorkchainAndHash();
                var myWorkchain = contract.getAddress().getWorkchain();
                assert (myWorkchain == extensionWorkchain) throw ERROR_EXTENSION_WRONG_WORKCHAIN;

                var storage = lazy AgenticWalletStorage.load();
                val removed = storage.extensions.delete(extensionAddrHash);
                assert (removed) throw ERROR_REMOVE_EXTENSION;
                if (!storage.isSignatureAllowed) {
                    assert (!storage.extensions.isEmpty()) throw ERROR_REMOVE_LAST_EXTENSION_WHEN_SIGNATURE_DISABLED;
                }
                storage.save();
            }

            SetSignatureAllowedExtraAction => {
                assert (isExtension) throw ERROR_ONLY_EXTENSION_CAN_CHANGE_SIGNATURE_MODE;

                var storage = lazy AgenticWalletStorage.load();
                assert (storage.isSignatureAllowed != action.allowSignature) throw ERROR_THIS_SIGNATURE_MODE_ALREADY_SET;
                if (!action.allowSignature) {
                    assert (!storage.extensions.isEmpty()) throw ERROR_DISABLE_SIGNATURE_WHEN_EXTENSIONS_IS_EMPTY;
                }
                storage.isSignatureAllowed = action.allowSignature;
                storage.save();
            }

            else => throw ERROR_UNSUPPORTED_ACTION
        }
        if (!extraActions.hasNext()) {
            return;
        }
        extraActions = extraActions.getNext();
    }
}

fun processActions(
    outActions: OutActionsCell?,
    extraActions: Cell<SnakedExtraActions>?,  // CUSTOM: Cell<SnakedExtraActions> instead of SnakedExtraActions
    isExternal: bool,
    isExtension: bool,
) {
    if (outActions != null) {
        // Simply set the C5 register with all pre-computed actions after verification:
        setTvmRegisterC5(outActions.verifyC5Actions(isExternal));
    }
    // CUSTOM: load extraActions ref
    if (extraActions != null) {
        processExtraActions(extraActions.load(), isExtension);
    }
}


// CUSTOM: initialized wallet accepts wallet-v5 messages plus direct deploy
// and owner-only operator rotation messages.
type AllowedMessageToWallet =
    | ExtensionActionRequest
    | InternalSignedRequest
    | ChangeOperatorMsg
    | ChangeNftContentMsg
    | ProveOwnershipMsg
    | RequestOwnerMsg

type AllowedExternalMessageToWallet = ExternalSignedRequest

fun onExternalMessage(inMsgBody: slice) {
    var signature = inMsgBody.getLastBits(SIZE_SIGNATURE);
    var signedSlice = inMsgBody.removeLastBits(SIZE_SIGNATURE);

    var msg = AllowedExternalMessageToWallet.fromSlice(signedSlice, {
        throwIfOpcodeDoesNotMatch: ERROR_INVALID_MESSAGE_OPERATION,
    });

    var storage = lazy AgenticWalletStorage.load();
    // CUSTOM: check that wallet is initialized
    assert (storage.walletData != null) throw ERROR_NOT_INITIALIZED;
    var walletData = storage.walletData.load();  

    assert (walletData.operatorPublicKey != 0 && isSignatureValid(signedSlice.hash(), signature, walletData.operatorPublicKey)) throw ERROR_INVALID_SIGNATURE;
    assert (storage.isSignatureAllowed | storage.extensions.isEmpty()) throw ERROR_SIGNATURE_DISABLED;
    assert (msg.seqno == storage.seqno) throw ERROR_INVALID_SEQNO;
    // CUSTOM: request is bound to immutable NFT item index, not wallet-v5 subwallet id.
    assert (msg.walletNftIndex == storage.nftItemIndex) throw ERROR_INVALID_WALLET_ID;
    assert (msg.validUntil > blockchain.now()) throw ERROR_EXPIRED;

    acceptExternalMessage();

    // Store and commit the seqno increment to prevent replays even if the subsequent requests fail.
    storage.isSignatureAllowed = true;
    storage.seqno += 1;
    storage.save();

    commitContractDataAndActions();
    processActions(msg.outActions, msg.extraActions, true, false);
}


@on_bounced_policy("manual")
fun onInternalMessage(in: InMessage) {
    var storage = lazy AgenticWalletStorage.load();

    // CUSTOM: before initialization the wallet accepts only direct deploy.
    if (storage.walletData == null) {
        val deployMsg = DeployWalletMsg.fromSlice(in.body, {
            throwIfOpcodeDoesNotMatch: ERROR_NOT_INITIALIZED,
        });
        initWallet(storage, in.senderAddress, deployMsg);
        return;
    }

    val msg = lazy AllowedMessageToWallet.fromSlice(in.body);

    match (msg) {
        InternalSignedRequest => {
            val bodyLongEnough = in.body.remainingBitsCount() >= SIZE_SIGNATURE + MIN_SIGNED_REQUEST_BITS;
            if (!bodyLongEnough) {
                return;     // don't try to parse it (it will fail), just ignore
            }

            var signature = in.body.getLastBits(SIZE_SIGNATURE);
            var signedSlice = in.body.removeLastBits(SIZE_SIGNATURE);

            var walletData = lazy storage.walletData.load();
            if (walletData.operatorPublicKey == 0 || !isSignatureValid(signedSlice.hash(), signature, walletData.operatorPublicKey)) {
                return;
            }

            assert (storage.isSignatureAllowed | storage.extensions.isEmpty()) throw ERROR_SIGNATURE_DISABLED;
            assert (msg.seqno == storage.seqno) throw ERROR_INVALID_SEQNO;
            // CUSTOM: request is bound to immutable NFT item index, not wallet-v5 subwallet id.
            assert (msg.walletNftIndex == storage.nftItemIndex) throw ERROR_INVALID_WALLET_ID;
            assert (msg.validUntil > blockchain.now()) throw ERROR_EXPIRED;

            // Store and commit the seqno increment to prevent replays even if the subsequent requests fail.
            storage.isSignatureAllowed = true;
            storage.seqno += 1;
            storage.save();
            
            commitContractDataAndActions();
            processActions(msg.outActions, msg.extraActions, false, false);
        }

        ExtensionActionRequest => {
            // CUSTOM: skip checks if senderAddress == ownerAddress
            var walletData = lazy storage.walletData.load();
            if (in.senderAddress != walletData.ownerAddress) {
                // END CUSTOM CODE
                var (senderWorkchain, senderAddrHash) = in.senderAddress.getWorkchainAndHash();
                var myWorkchain = contract.getAddress().getWorkchain();
                if (myWorkchain != senderWorkchain) {
                    return;
                }

                val storage = lazy AgenticWalletStorage.load();
                if (!storage.extensions.exists(senderAddrHash)) {
                    // Note that some random contract may have deposited funds with this prefix,
                    // so we accept the funds silently instead of throwing an error (wallet v4 does the same).
                    return;
                }
            }

            var extraActionsRef: Cell<SnakedExtraActions>? = null;
            if (msg.hasExtraActions) {
                extraActionsRef = msg.extraActions.toCell();
            }
            processActions(msg.outActions, extraActionsRef, false, true);
        }

        // CUSTOM: owner-only internal operator rotation.
        ChangeOperatorMsg => {
            var walletData = lazy storage.walletData.load();
            assert (in.senderAddress == walletData.ownerAddress) throw ERROR_INCORRECT_SENDER;

            walletData.operatorPublicKey = msg.newOperatorPublicKey;
            storage.walletData = walletData.toCell();
            storage.save();
        }
        
        // CUSTOM: owner-only internal NFT content change.
        ChangeNftContentMsg => {
            var walletData = lazy storage.walletData.load();
            assert (in.senderAddress == walletData.ownerAddress) throw ERROR_INCORRECT_SENDER;
            
            walletData.nftItemContent = msg.newNftItemContent;
            storage.walletData = walletData.toCell();
            storage.save();
        }

        // TEP-85 SBT: prove_ownership (owner-only)
        ProveOwnershipMsg => {
            var walletData = lazy storage.walletData.load();
            assert (in.senderAddress == walletData.ownerAddress) throw ERROR_INCORRECT_SENDER;
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: msg.dest,
                body: OwnershipProofMsg {
                    queryId: msg.queryId,
                    itemId: storage.nftItemIndex,
                    owner: walletData.ownerAddress,
                    data: msg.forwardPayload,
                    revokedAt: 0,
                    content: msg.withContent ? walletData.nftItemContent : null,
                },
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        // TEP-85 SBT: request_owner (anyone)
        RequestOwnerMsg => {
            var walletData = lazy storage.walletData.load();
            createMessage({
                bounce: BounceMode.Only256BitsOfBody,
                value: 0,
                dest: msg.dest,
                body: OwnerInfoMsg {
                    queryId: msg.queryId,
                    itemId: storage.nftItemIndex,
                    initiator: in.senderAddress,
                    owner: walletData.ownerAddress,
                    data: msg.forwardPayload,
                    revokedAt: 0,
                    content: msg.withContent ? walletData.nftItemContent : null,
                },
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        else => {
            // CUSTOM: bounce SBT-related operations
            // int op::destroy() asm "0x1f04537a PUSHINT";
            // int op::revoke() asm "0x6f89f5e3 PUSHINT";
            // int op::take_excess() asm "0xd136d3b3 PUSHINT";
            // int op::transfer() asm "0x5fcc3d14 PUSHINT"
            if (in.body.remainingBitsCount() >= 32) {
                val op = in.body.loadUint(32);
                assert (op != 0x1f04537a && op != 0x6f89f5e3 && op != 0xd136d3b3 && op != 0x5fcc3d14) throw ERROR_UNKNOWN_OPERATION;
            }
            // if opcode is strange or body is empty at all (for instance, bounced messages)
            // just ignore, do not throw
        }
    }
}


get fun is_signature_allowed(): bool {
    val storage = lazy AgenticWalletStorage.load();
    return storage.isSignatureAllowed;
}

get fun seqno(): int {
    val storage = lazy AgenticWalletStorage.load();
    return storage.seqno;
}


get fun get_subwallet_id(): int {
    val storage  = lazy AgenticWalletStorage.load();
    return storage.nftItemIndex;
}

get fun get_public_key(): int {
    val storage = lazy AgenticWalletStorage.load();
    val walletData = loadWalletData(storage);
    // CUSTOM: uninitialized wallets expose no operator key.
    if (walletData == null) {
        return -1;
    }
    // END
    return (walletData as WalletRuntimeData).operatorPublicKey;
}

// CUSTOM: getter for immutable initial operator key used for wallet index derivation.
get fun get_origin_public_key(): int {
    val storage = lazy AgenticWalletStorage.load();
    val walletData = loadWalletData(storage);
    if (walletData == null) {
        return -1;
    }
    return (walletData as WalletRuntimeData).originOperatorPublicKey;
}

// Returns raw dictionary (or null if empty) where keys are address hashes. Workchains of extensions are same with wallet smart contract workchain
get fun get_extensions(): map<uint256, bool>? {
    val storage = lazy AgenticWalletStorage.load();
    return storage.extensions;
}

struct NftDataReply {
    isInitialized: bool
    itemIndex: int
    collectionAddress: address
    ownerAddress: address? = null
    content: cell? = null
}

// CUSTOM: NFT item getter preserved for collection indexing compatibility.
get fun get_nft_data(): NftDataReply {
    val storage = lazy AgenticWalletStorage.load();
    val walletData = loadWalletData(storage);
    if (walletData == null) {
        return {
            isInitialized: false,
            itemIndex: storage.nftItemIndex,
            collectionAddress: storage.collectionAddress
        };
    }
    val initializedWalletData = walletData as WalletRuntimeData;
    return {
        isInitialized: true,
        itemIndex: storage.nftItemIndex,
        collectionAddress: storage.collectionAddress,
        ownerAddress: initializedWalletData.ownerAddress,
        content: initializedWalletData.nftItemContent,
    };
}

get fun get_authority_address(): address {
    return createAddressNone() as address;
}

get fun  get_revoked_time(): uint64 {
    return 0;
}
