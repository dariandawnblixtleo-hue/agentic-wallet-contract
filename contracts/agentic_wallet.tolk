import "@stdlib/gas-payments"
import "errors"
import "wallet_storage"
import "messages"
import "c5-register-validation"

const SIZE_SIGNATURE = 512
const OP_EXTERNAL_SIGNED_REQUEST = 0x7369676e
const OP_SET_AGENT_STATE_EXTERNAL = 0xf198cc9e
const OP_OWNERSHIP_ASSIGNED = 0x05138d91
const ERROR_UNKNOWN_COMMAND = 0xffff

fun processActions(outActions: OutActionsCell?, isExternal: bool) {
    if (outActions != null) {
        // Set the C5 register with precomputed actions after validation.
        setTvmRegisterC5(outActions.verifyC5Actions(isExternal));
    }
}

type AllowedInternalMessageToWalletV5 = InternalSignedRequestMsg | DeployNftMsg | MasterInternalCommandMsg | ChangeKeypairMsg

fun checkSignature(
    signedSlice: slice,
    signature: slice,
    agentDisabled: bool,
    agentPublicKey: uint256,
    masterPublicKey: uint256,
    msgSeqno: uint32,
    msgWalletId: uint32,
    msgValidUntil: uint32,
    expectedSeqno: uint32,
    expectedWalletId: uint32
) {
    val signedHash = signedSlice.hash();

    // Signed by the agent.
    if (!isSignatureValid(signedHash, signature, masterPublicKey)) {
        assert (!agentDisabled && isSignatureValid(signedHash, signature, agentPublicKey)) throw ERROR_INVALID_SIGNATURE;
    }

    assert (msgSeqno == expectedSeqno) throw ERROR_INVALID_SEQNO;
    assert (msgWalletId == expectedWalletId) throw ERROR_INVALID_WALLET_ID;
    assert (msgValidUntil > blockchain.now()) throw ERROR_EXPIRED;
}

fun onExternalMessage(inMsgBody: slice) {
    var signature = inMsgBody.getLastBits(SIZE_SIGNATURE);
    var signedSlice = inMsgBody.removeLastBits(SIZE_SIGNATURE);
    val opcode = inMsgBody.loadUint(32);
    val walletId = inMsgBody.loadUint(32);
    val validUntil = inMsgBody.loadUint(32);
    val seqno = inMsgBody.loadUint(32);

    var storage = lazy NftItemStorage.load();
    assert (storage.walletData != null) throw ERROR_NOT_INITIALIZED;
    var walletData = lazy storage.walletData.load();

    checkSignature(
        signedSlice,
        signature,
        storage.agentDisabled,
        walletData.agentPublicKey,
        walletData.masterPublicKey,
        seqno,
        walletId,
        validUntil,
        storage.seqno,
        walletData.subwalletId
    );

    
    storage.seqno += 1;
    if (opcode == OP_SET_AGENT_STATE_EXTERNAL) {
        acceptExternalMessage();
        storage.agentDisabled = inMsgBody.loadBool();
        storage.save();
    } else if (opcode == OP_EXTERNAL_SIGNED_REQUEST) {
        acceptExternalMessage();
        storage.save();
        commitContractDataAndActions();
        processActions(inMsgBody.loadMaybeRef(), true);
    }
}

@on_bounced_policy("manual")        // tell the compiler "don't insert code to filter out bounced messages"
fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedInternalMessageToWalletV5.fromSlice(in.body);

    match (msg) {
        DeployNftMsg => {
            var storage = lazy NftItemStorage.load();
            assert (storage.collectionAddress == in.senderAddress) throw ERROR_INCORRECT_SENDER;
            assert (storage.walletData == null) throw ERROR_ALREADY_DEPLOYED;

            storage.walletData = msg.agenticWalletData;
            storage.save();

            // Optional notification to the owner about wallet deployment.
            val deployedWalletData = lazy msg.agenticWalletData.load();
            val owner = deployedWalletData.masterWalletAddress;
            if (in.valueCoins > ton("0.01")) {
                createMessage<cell>({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: owner,
                    body: beginCell()
                            .storeUint(OP_OWNERSHIP_ASSIGNED, 32)
                            .storeUint(msg.queryId, 64)
                            .storeAddress(storage.collectionAddress)
                            .storeUint(0, 33)
                            .storeSlice("New agentic wallet deployed")
                        .endCell(),
                }).send(SEND_MODE_PAY_FEES_SEPARATELY);
            }
        }

        // Owner command to disable/enable the agent with a text comment.
        MasterInternalCommandMsg => {
            var storage = lazy NftItemStorage.load();
            assert (storage.walletData != null) throw ERROR_NOT_INITIALIZED;
            val walletData = lazy storage.walletData.load();
            val owner = walletData.masterWalletAddress;
            assert (in.senderAddress == owner) throw ERROR_INCORRECT_SENDER;

            if (msg.command.bitsEqual("deactivate")) {
                storage.agentDisabled = true;
            } else if (msg.command.bitsEqual("activate")) {
                storage.agentDisabled = false;
            } else {
                throw ERROR_UNKNOWN_COMMAND;
            }
            storage.save();
        }

        // Transfer control to another agent.
        ChangeKeypairMsg => {
            var storage = lazy NftItemStorage.load();
            assert (storage.walletData != null) throw ERROR_NOT_INITIALIZED;
            var walletData = lazy storage.walletData.load();
            assert (in.senderAddress == walletData.masterWalletAddress) throw ERROR_INCORRECT_SENDER;
            walletData.agentPublicKey = msg.newAgentPublicKey;
            storage.walletData = walletData.toCell();
            storage.save();
        }

        InternalSignedRequestMsg => {
            val bodyLongEnough = in.body.remainingBitsCount() >= SIZE_SIGNATURE + 128;
            if (!bodyLongEnough) {
                return;     // don't try to parse it (it will fail), just ignore
            }

            var signature = in.body.getLastBits(SIZE_SIGNATURE);
            var signedSlice = in.body.removeLastBits(SIZE_SIGNATURE);

            var storage = lazy NftItemStorage.load();
            assert (storage.walletData != null) throw ERROR_NOT_INITIALIZED;
            var walletData = lazy storage.walletData.load();

            checkSignature(
                signedSlice,
                signature,
                storage.agentDisabled,
                walletData.agentPublicKey,
                walletData.masterPublicKey,
                msg.seqno,
                msg.walletId,
                msg.validUntil,
                storage.seqno,
                walletData.subwalletId
            );

            // Persist seqno increment before action processing to prevent replay on failures.
            storage.seqno += 1;
            storage.save();

            processActions(msg.outActions, false);
        }

        else => {
            // if opcode is strange or body is empty at all (for instance, bounced messages)
            // just ignore, do not throw
        }
    }
}

get fun seqno(): int {
    val storage = lazy NftItemStorage.load();
    return storage.seqno;
}

get fun get_subwallet_id(): int {
    val storage = lazy NftItemStorage.load();
    if (storage.walletData == null) {
        return -1;
    }
    val walletData: AgenticWalletData = lazy AgenticWalletData.fromCell(storage.walletData);
    return walletData.subwalletId;
}

get fun get_public_key(): int {
    val storage = lazy NftItemStorage.load();
    if (storage.walletData == null) {
        return -1;
    }
    val walletData: AgenticWalletData = lazy AgenticWalletData.fromCell(storage.walletData);
    return walletData.masterPublicKey;
}

get fun get_nft_data(): (bool, uint256, address, address?, cell?) {
    val storage = lazy NftItemStorage.load();
    if (storage.walletData == null) {
        return (false, storage.nftItemIndex, storage.collectionAddress, null, null);
    }
    val walletData: AgenticWalletData = lazy AgenticWalletData.fromCell(storage.walletData);
    return (true, storage.nftItemIndex, storage.collectionAddress, walletData.masterWalletAddress, walletData.nftItemContent);
}
