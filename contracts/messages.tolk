import "wallet_storage"
import "c5-register-validation"

struct (0x02) AddExtensionExtraAction {
    addr: address
}

struct (0x03) RemoveExtensionExtraAction {
    addr: address
}

struct (0x04) SetSignatureAllowedExtraAction {
    allowSignature: bool
}

type ExtraAction =
    | AddExtensionExtraAction
    | RemoveExtensionExtraAction
    | SetSignatureAllowedExtraAction

type SnakedExtraActions = RemainingBitsAndRefs

fun SnakedExtraActions.hasNext(self) {
    return self.remainingRefsCount()
}

fun SnakedExtraActions.getNext(self): SnakedExtraActions {
    return self.preloadRef().beginParse()
}

struct (0x6578746e) ExtensionActionRequest {
    queryId: uint64
    outActions: OutActionsCell?
    hasExtraActions: bool
    extraActions: SnakedExtraActions
}

struct (0x73696e74) InternalSignedRequest {
    walletNftIndex: uint256
    validUntil: uint32
    seqno: uint32
    outActions: OutActionsCell?
    extraActions: Cell<SnakedExtraActions>?  // CUSTOM: delete "hasExtraActions", move "extraActions" to ref.
    // Ends with a signature (512 bits), parsed and verified separately.
}

struct (0x7369676e) ExternalSignedRequest {
    walletNftIndex: uint256
    validUntil: uint32
    seqno: uint32
    outActions: OutActionsCell?
    extraActions: Cell<SnakedExtraActions>?  // CUSTOM: delete "hasExtraActions", move "extraActions" to ref.
    // Ends with a signature (512 bits), parsed and verified separately.
}

struct (0x0609e47b) DeployWalletMsg {
    queryId: uint64
    walletData: Cell<WalletRuntimeData>
    senderOriginOperatorPublicKey: uint256
}

struct (0xea4e36cf) ChangeOperatorMsg {
    queryId: uint64
    newOperatorPublicKey: uint256
}

struct (0x1a0b9d51) ChangeNftContentMsg {
    queryId: uint64
    newNftItemContent: cell?
}

struct (0x00000003) ChangeCollectionAdminMsg {
    queryId: uint64
    newAdminAddress: address
}
