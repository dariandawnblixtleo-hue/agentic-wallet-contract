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

struct (0xed84cbf0) ExtensionActionRequest {
    queryId: uint64
    outActions: OutActionsCell?
    hasExtraActions: bool
    extraActions: SnakedExtraActions
}

struct (0x4a3ca895) InternalSignedRequest {
    walletNftIndex: uint256
    validUntil: uint32
    seqno: uint32
    outActions: OutActionsCell?
    extraActions: Cell<SnakedExtraActions>?  // CUSTOM: delete "hasExtraActions", move "extraActions" to ref.
    // Ends with a signature (512 bits), parsed and verified separately.
}

struct (0xbf235204) ExternalSignedRequest {
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

struct (0x04ded148) ProveOwnershipMsg {
    queryId: uint64
    dest: address
    forwardPayload: cell
    withContent: bool
}

struct (0xd0c3bfea) RequestOwnerMsg {
    queryId: uint64
    dest: address
    forwardPayload: cell
    withContent: bool
}

struct (0x0524c7ae) OwnershipProofMsg {
    queryId: uint64
    itemId: uint256
    owner: address
    data: cell
    revokedAt: uint64
    content: cell?
}

struct (0x0dd607e3) OwnerInfoMsg {
    queryId: uint64
    itemId: uint256
    initiator: address
    owner: address
    data: cell
    revokedAt: uint64
    content: cell?
}

struct (0x00000003) ChangeCollectionAdminMsg {
    queryId: uint64
    newAdminAddress: address
}

struct (0x00000004) ChangeCollectionContentMsg {
    queryId: uint64
    newContent: cell
}

struct (0x00000005) ChangeCollectionDataAndCodeMsg {
    queryId: uint64
    newData: cell
    newCode: cell
}
