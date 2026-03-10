import "errors"
import "wallet_storage"
import "messages"


fun assertDeploySenderAllowed(storage: AgenticWalletStorage, senderAddress: address, walletData: WalletRuntimeData, senderOriginOperatorPublicKey: uint256) {
    if (senderOriginOperatorPublicKey == 0) {
        assert (senderAddress == walletData.ownerAddress) throw ERROR_INCORRECT_SENDER;
        assert (walletData.deployedByUser) throw ERROR_INCORRECT_SENDER;
        return;
    }

    assert (!walletData.deployedByUser) throw ERROR_INCORRECT_SENDER;
    val senderIndex = calcWalletIndex(walletData.ownerAddress, senderOriginOperatorPublicKey, true);
    val expectedSenderAddress = calcWalletAddress(
        senderIndex,
        storage.collectionAddress,
        contract.getCode()
    ).calculateAddress();
    assert (senderAddress == expectedSenderAddress) throw ERROR_INCORRECT_SENDER;
}

fun initWallet(storage: AgenticWalletStorage, senderAddress: address, msg: DeployWalletMsg) {
    val walletData = lazy msg.walletData.load();

    assert (storage.isSignatureAllowed && storage.seqno == 0 && storage.extensions.isEmpty()) throw ERROR_INVALID_DEPLOY_DATA;
    assert (walletData.operatorPublicKey == walletData.originOperatorPublicKey) throw ERROR_INVALID_DEPLOY_DATA;
    assertDeploySenderAllowed(storage, senderAddress, walletData, msg.senderOriginOperatorPublicKey);

    val expectedIndex = calcWalletIndex(walletData.ownerAddress, walletData.originOperatorPublicKey, walletData.deployedByUser);
    assert (expectedIndex == storage.nftItemIndex) throw ERROR_INVALID_DEPLOY_INDEX;

    val ownerWorkchain = walletData.ownerAddress.getWorkchain();
    val myWorkchain = contract.getAddress().getWorkchain();
    assert (ownerWorkchain == myWorkchain) throw ERROR_OWNER_WRONG_WORKCHAIN;

    storage.walletData = msg.walletData;

    storage.save();
}
