import "wallet_storage"
import "c5-register-validation"
import "collection_storage"

struct (0x00000001) RequestDeployNftMsg {
    queryId: uint64
    userSignature: bits512
    initParams: Cell<AgenticWalletData>
}

struct (0x00000003) ChangeCollectionAdminMsg {
    queryId: uint64
    newAdminAddress: address
}

struct (0xd53276db) ReturnExcessesBackMsg {
    queryId: uint64
}

struct (0x0609e47b) DeployNftMsg {
    queryId: uint64
    agenticWalletData: Cell<AgenticWalletData>
}

struct (0x73696e74) InternalSignedRequestMsg {
    walletId: uint32
    validUntil: uint32
    seqno: uint32
    outActions: OutActionsCell?
    // Ends with a signature (512 bits), parsed and verified separately.
}

struct (0x7369676e) ExternalSignedRequestMsg {
    walletId: uint32
    validUntil: uint32
    seqno: uint32
    outActions: OutActionsCell?
    // Ends with a signature (512 bits), parsed and verified separately.
}

struct (0xf198cc9e) SetAgentStateExternalMsg {
    walletId: uint32
    validUntil: uint32
    seqno: uint32
    agentDisabled: bool
    // Ends with a signature (512 bits), parsed and verified separately.
}

struct (0xea4e36cf) ChangeKeypairMsg {
    queryId: uint64
    newAgentPublicKey: uint256
}

struct (0x00000000) MasterInternalCommandMsg {
    command: SnakeString
}
