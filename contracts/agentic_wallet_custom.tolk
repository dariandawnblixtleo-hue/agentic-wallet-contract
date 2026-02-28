import "errors"
import "wallet_storage"
import "messages"


fun assertDeploySenderAllowed(storage: AgenticWalletStorage, senderAddress: address, walletData: WalletRuntimeData, senderOriginOperatorPublicKey: uint256) {
    if (senderOriginOperatorPublicKey == 0) {
        assert (senderAddress == walletData.ownerAddress) throw ERROR_INCORRECT_SENDER;
        return;
    }

    val senderIndex = calcWalletIndex(walletData.ownerAddress, senderOriginOperatorPublicKey);
    val expectedSenderAddress = calcWalletAddress(
        senderIndex,
        storage.collectionAddress,
        contract.getCode()
    ).calculateAddress();
    assert (senderAddress == expectedSenderAddress) throw ERROR_INCORRECT_SENDER;
}

fun initWallet(storage: AgenticWalletStorage, senderAddress: address, msg: DeployWalletMsg) {
    assert (storage.isSignatureAllowed && storage.seqno == 0 && storage.extensions.isEmpty()) throw ERROR_INVALID_DEPLOY_DATA;

    storage.walletData = msg.walletData;
    val walletData = lazy msg.walletData.load();
    assert (walletData.operatorPublicKey == walletData.originOperatorPublicKey) throw ERROR_INVALID_DEPLOY_DATA;
    val expectedIndex = calcWalletIndex(walletData.ownerAddress, walletData.originOperatorPublicKey);
    assert (expectedIndex == storage.nftItemIndex) throw ERROR_INVALID_DEPLOY_INDEX;
    
    val (ownerWorkchain, _) = walletData.ownerAddress.getWorkchainAndHash();
    val myWorkchain = contract.getAddress().getWorkchain();
    assert (ownerWorkchain == myWorkchain) throw ERROR_OWNER_WRONG_WORKCHAIN;
    assertDeploySenderAllowed(storage, senderAddress, walletData, msg.senderOriginOperatorPublicKey);

    storage.save();
}
