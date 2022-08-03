pragma abicoder v2;
pragma solidity 0.7.5;

import "./lib/ArrayUtils.sol";
import "./lib/ExtMath.sol";
import "./exchange/ExchangeCore.sol";

interface IFr0ntierToken {
    function mine(address dst, uint256 rawAmount) external;
}

interface IDataWarehouse {
    function getHighestSellingPriceInWei(address nftAddr, uint256 tokenID)
        external
        returns (uint256);

    function updateHighestSellingPriceInWei(
        address nftAddr,
        uint256 tokenID,
        uint256 newHigestPrice
    ) external;

    function getLastNFTTradeBlockHeight(address nftAddr, uint256 tokenID)
        external
        returns (uint256);

    function updateNFTTradeBlockHeight(address nftAddr, uint256 tokenID)
        external;

    function isAWhitelistedPaymentToken(address tokenAddr)
        external
        returns (bool);

    function isAWhitelistedERC721NFTToken(address tokenAddr)
        external
        returns (bool);

    function isAWhitelistedERC1155NFTToken(address tokenAddr)
        external
        returns (bool);
}

//
// Separate TokenSwapAgent from the Fr0ntierMarketplace to simplify the marketplace upgrading process.
// Without this separation, each time we upgrade Fr0ntierMarketplace to a new contract, all the users
// may need to approve the new Fr0ntierMarketplace to access their tokens.
//
contract TokenSwapAgent {
    address public superAdmin;

    address public admin;

    address public marketplace;

    constructor(address superAdmin_, address admin_) {
        superAdmin = superAdmin_;
        admin = admin_;
    }

    function setSuperAdmin(address superAdmin_) external onlySuperAdmin {
        superAdmin = superAdmin_;
    }

    function setAdmin(address admin_) external onlySuperAdmin {
        admin = admin_;
    }

    function setMarketplace(address marketplace_) external onlyAdmin {
        marketplace = marketplace_;
    }

    function transferFee(
        address erc20PaymentTokenAddr,
        address buyerAddr,
        address platformFeeRecipient,
        uint256 platformFeeInERC20
    ) external onlyMarketplace returns (bool result) {
        ERC20 paymentToken = ERC20(erc20PaymentTokenAddr);
        require(
            paymentToken.transferFrom(
                buyerAddr,
                platformFeeRecipient,
                platformFeeInERC20
            ),
            "ERC20 fee transfer failed"
        );
        return true;
    }

    function proxyCall(
        address dest,
        AuthenticatedProxy.HowToCall howToCall,
        bytes memory data
    ) external onlyMarketplace returns (bool result) {
        bytes memory ret;
        if (howToCall == AuthenticatedProxy.HowToCall.Call) {
            (result, ret) = dest.call(data);
        } else if (howToCall == AuthenticatedProxy.HowToCall.DelegateCall) {
            (result, ret) = dest.delegatecall(data);
        }
        return result;
    }

    modifier onlySuperAdmin() {
        require(
            msg.sender == superAdmin,
            "only the super admin can perform this action"
        );
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "only the admin can perform this action");
        _;
    }

    modifier onlyMarketplace() {
        require(
            msg.sender == marketplace,
            "only the marketplace can perform this action"
        );
        _;
    }
}

contract Fr0ntierMarketplace is ExchangeCore {
    using SafeMath for uint256;

    struct NFTTradeMetadata {
        address seller;
        address buyer;
        address nftTokenAddress;
        uint256 nftTokenID;
        uint256 nftAmount;
        address paymentTokenAddress; // paymentTokenAddress == 0x0 means paying with ETH
        uint256 paymentTokenAmount;
        uint256 fr0ntierMined;
    }

    struct LiquidityMiningParameters {
        uint256 epsilon;
        uint256 alpha;
        uint256 gamma;
        uint256 omega;
        uint256 priceThreshold; // the minimal ETH payment for Fr0ntier mining
        uint256 maxRewardPerTrade;
    }

    string public constant name = "Wyvern Exchange";

    string public constant version = "3.1";

    string public constant codename = "Ancalagon";

    /// @notice The super admin address
    address public superAdmin;

    /// @notice The admin address
    address public admin;

    /// @notice The on-chain governor contract address
    address public governor;

    /// @notice The on-chain governor contract address
    TokenSwapAgent public tokenSwapAgent;

    /// @notice The primary market platform fee split in basis points
    uint256 public primaryMarketPlatformFeeSplitBasisPoints;

    /// @notice The secondary market platform fee split in basis points
    uint256 public secondaryMarketPlatformFeeSplitBasisPoints;

    /// @notice The recipient of the platform fee
    address payable public platformFeeRecipient;

    /// @notice If NFT liquidity mining is enabled
    bool public liquidityMiningEnabled;

    /// @notice If NFT liquidity mining only enabled for whitelisted NFTs
    bool public miningOnlyForWhitelistedNFTs;

    /// @notice paramters for the liquidity mining
    LiquidityMiningParameters public lmp;

    /// @notice the address of Fr0ntier data warehouse
    IDataWarehouse public dataWarehouse;

    /// @notice the address of the Fr0ntier token
    IFr0ntierToken public fr0ntierToken;

    /// @notice if the marketplace is paused
    bool public paused;

    event SuperAdminChanged(address superAdmin, address newSuperAdmin);

    event AdminChanged(address admin, address newAdmin);

    event GovernorChanged(address governor, address newGovernor);

    event TokenSwapAgentChanged(
        address tokenSwapAgent,
        address newTokeSwapAgent
    );

    event DataWarehouseChanged(address dataWarehouse, address newDataWarehouse);

    event PrimaryMarketPlatformFeeSplitBasisPointsChanged(
        uint256 splitBasisPoints,
        uint256 newSplitBasisPoints
    );

    event SecondaryMarketPlatformFeeSplitBasisPointsChanged(
        uint256 splitBasisPoints,
        uint256 newSplitBasisPoints
    );

    event PlatformFeeRecipientChanged(
        address platformFeeRecipient,
        address newPlatformFeeRecipient
    );

    event NFTTraded(
        address indexed seller,
        address indexed buyer,
        address indexed nftTokenAddress,
        uint256 nftTokenID,
        uint256 nftAmount,
        address paymentTokenAddress,
        uint256 paymentTokenAmount,
        uint256 fr0ntierMined
    );

    event CalculateFr0ntierMined(
        uint256 alpha,
        uint256 priceInWei,
        uint256 highestSellingPriceInWei,
        uint256 gamma,
        uint256 omega,
        uint256 blockHeight,
        uint256 lastTradeBlockHeight,
        uint256 epsilon,
        uint256 priceThreshold,
        uint256 maxRewardPerTrade
    );

    event MinedFr0ntier(address indexed recipient, uint256 fr0ntierMined);

    event ETHSplit(
        address indexed seller,
        uint256 sellerEarning,
        address indexed platformFeeRecipient,
        uint256 platformFee
    );

    constructor(
        uint256 chainId,
        bytes memory customPersonalSignPrefix,
        address superAdmin_,
        address admin_,
        address payable platformFeeRecipient_
    ) {
        DOMAIN_SEPARATOR = hash(
            EIP712Domain({
                name: name,
                version: version,
                chainId: chainId,
                verifyingContract: address(this)
            })
        );
        if (customPersonalSignPrefix.length > 0) {
            personalSignPrefix = customPersonalSignPrefix;
        }

        superAdmin = superAdmin_;
        emit SuperAdminChanged(address(0), superAdmin);
        admin = admin_;
        emit AdminChanged(address(0), admin);
        platformFeeRecipient = platformFeeRecipient_;
        emit PlatformFeeRecipientChanged(address(0), platformFeeRecipient);
        paused = false;
        miningOnlyForWhitelistedNFTs = true;
        liquidityMiningEnabled = false;
    }

    function setSuperAdmin(address superAdmin_) external onlySuperAdmin {
        emit SuperAdminChanged(superAdmin, superAdmin_);
        superAdmin = superAdmin_;
    }

    function setAdmin(address admin_) external onlySuperAdmin {
        emit AdminChanged(admin, admin_);
        admin = admin_;
    }

    function setGovernor(address governor_) external onlyAdmin {
        emit GovernorChanged(governor, governor_);
        governor = governor_;
    }

    function setTokenSwapAgent(address tokenSwapAgent_) external onlyAdmin {
        emit TokenSwapAgentChanged(address(tokenSwapAgent), tokenSwapAgent_);
        tokenSwapAgent = TokenSwapAgent(tokenSwapAgent_);
    }

    function setDataWarehouse(address dataWarehouse_) external onlyAdmin {
        emit DataWarehouseChanged(address(dataWarehouse), dataWarehouse_);
        dataWarehouse = IDataWarehouse(dataWarehouse_);
    }

    function setPrimaryMarketPlatformFeeSplitBasisPoints(
        uint256 splitBasisPoints_
    ) external onlyAdmin {
        require(splitBasisPoints_ <= 10000, "invalid split basis points");
        emit PrimaryMarketPlatformFeeSplitBasisPointsChanged(
            primaryMarketPlatformFeeSplitBasisPoints,
            splitBasisPoints_
        );
        primaryMarketPlatformFeeSplitBasisPoints = splitBasisPoints_;
    }

    function setSecondaryMarketPlatformFeeSplitBasisPoints(
        uint256 splitBasisPoints_
    ) external onlyAdmin {
        require(splitBasisPoints_ <= 10000, "invalid split basis points");
        emit SecondaryMarketPlatformFeeSplitBasisPointsChanged(
            secondaryMarketPlatformFeeSplitBasisPoints,
            splitBasisPoints_
        );
        secondaryMarketPlatformFeeSplitBasisPoints = splitBasisPoints_;
    }

    function setPlatformFeeRecipient(address payable platformFeeRecipient_)
        external
        onlyAdmin
    {
        emit PlatformFeeRecipientChanged(
            platformFeeRecipient,
            platformFeeRecipient_
        );
        platformFeeRecipient = platformFeeRecipient_;
    }

    function setFr0ntierToken(address fr0ntierToken_) external onlyAdmin {
        fr0ntierToken = IFr0ntierToken(fr0ntierToken_);
    }

    function enableNFTLiqudityMining(bool enabled) external onlyAdmin {
        liquidityMiningEnabled = enabled;
    }

    function enableLiqudityMiningOnlyForWhitelistedNFTs(bool whitelistedOnly)
        external
        onlyAdmin
    {
        miningOnlyForWhitelistedNFTs = whitelistedOnly;
    }

    function getLiquidityMiningParamEpsilon() external view returns (uint256) {
        return lmp.epsilon;
    }

    function getLiquidityMiningParamAlpha() external view returns (uint256) {
        return lmp.alpha;
    }

    function getLiquidityMiningParamGamma() external view returns (uint256) {
        return lmp.gamma;
    }

    function getLiquidityMiningParamOmega() external view returns (uint256) {
        return lmp.omega;
    }

    function getLiquidityMiningParamPriceThreshold()
        external
        view
        returns (uint256)
    {
        return lmp.priceThreshold;
    }

    function getLiquidityMiningParamMaxRewardPerTrade()
        external
        view
        returns (uint256)
    {
        return lmp.maxRewardPerTrade;
    }

    function updateLiquidityMiningParamEpsilon(uint256 epsilon)
        external
        onlyAdminOrGovernor
    {
        lmp.epsilon = epsilon;
    }

    function updateLiquidityMiningParamAlpha(uint256 alpha)
        external
        onlyAdminOrGovernor
    {
        lmp.alpha = alpha;
    }

    function updateLiquidityMiningParamGamma(uint256 gamma)
        external
        onlyAdminOrGovernor
    {
        lmp.gamma = gamma;
    }

    function updateLiquidityMiningParamOmega(uint256 omega)
        external
        onlyAdminOrGovernor
    {
        lmp.omega = omega;
    }

    function updateLiquidityMiningParamPriceThreshold(uint256 priceThreshold)
        external
        onlyAdminOrGovernor
    {
        lmp.priceThreshold = priceThreshold;
    }

    function updateLiquidityMiningParamMaxRewardPerTrade(
        uint256 maxRewardPerTrade
    ) external onlyAdminOrGovernor {
        lmp.maxRewardPerTrade = maxRewardPerTrade;
    }

    function updateLiquidityMiningParams(
        uint256 epsilon,
        uint256 alpha,
        uint256 gamma,
        uint256 omega,
        uint256 priceThreshold,
        uint256 maxRewardPerTrade
    ) external onlyAdminOrGovernor {
        lmp.epsilon = epsilon;
        lmp.alpha = alpha;
        lmp.gamma = gamma;
        lmp.omega = omega;
        lmp.priceThreshold = priceThreshold;
        lmp.maxRewardPerTrade = maxRewardPerTrade;
    }

    function pause() external onlyAdmin {
        paused = true;
    }

    function unpause() external onlyAdmin {
        paused = false;
    }

    // Assume the first order is initiated by the NFT seller, and the second order is initiated by the buyer (with either ETH or ERC20 tokens)
    function tradeNFT(
        uint256[16] memory uints,
        bytes4[2] memory staticSelectors,
        bytes memory firstExtradata,
        bytes memory firstCalldata,
        bytes memory secondExtradata,
        bytes memory secondCalldata,
        uint8[2] memory howToCalls,
        bytes32 metadata,
        bytes memory signatures
    ) public payable onlyWhenUnpaused {
        return
            _tradeNFT(
                Order(
                    address(uints[0]),
                    address(uints[1]),
                    address(uints[2]),
                    staticSelectors[0],
                    firstExtradata,
                    uints[3],
                    uints[4],
                    uints[5],
                    uints[6]
                ),
                Call(
                    address(uints[7]),
                    AuthenticatedProxy.HowToCall(howToCalls[0]),
                    firstCalldata
                ),
                Order(
                    address(uints[8]),
                    address(uints[9]),
                    address(uints[10]),
                    staticSelectors[1],
                    secondExtradata,
                    uints[11],
                    uints[12],
                    uints[13],
                    uints[14]
                ),
                Call(
                    address(uints[15]),
                    AuthenticatedProxy.HowToCall(howToCalls[1]),
                    secondCalldata
                ),
                signatures,
                metadata
            );
    }

    function _tradeNFT(
        Order memory firstOrder,
        Call memory firstCall,
        Order memory secondOrder,
        Call memory secondCall,
        bytes memory signatures,
        bytes32 metadata
    ) internal {
        _sanityChecks(firstOrder, firstCall, secondOrder, secondCall, metadata);

        NFTTradeMetadata memory tm = _extractNFTTradeMetadata(
            firstOrder,
            firstCall,
            secondOrder,
            secondCall
        );

        uint256 fr0ntierMined;
        fr0ntierMined = _performNFTLiquidityMining(tm);
        tm.fr0ntierMined = fr0ntierMined;

        atomicMatch(
            firstOrder,
            firstCall,
            secondOrder,
            secondCall,
            signatures,
            metadata
        );

        _updateNFTTradeBlockHeight(tm.nftTokenAddress, tm.nftTokenID);

        emit NFTTraded(
            tm.seller,
            tm.buyer,
            tm.nftTokenAddress,
            tm.nftTokenID,
            tm.nftAmount,
            tm.paymentTokenAddress,
            tm.paymentTokenAmount,
            tm.fr0ntierMined
        );
    }

    function _sanityChecks(
        Order memory firstOrder,
        Call memory firstCall,
        Order memory secondOrder,
        Call memory secondCall,
        bytes32 metadata
    ) internal returns (bool) {
        // check if the orders and calls are well-formed
        require(
            firstOrder.staticExtradata.length == 128,
            "firstCalldata is malformed"
        );
        require(
            secondOrder.staticExtradata.length == 128,
            "secondCalldata is malformed"
        );
        require(metadata == bytes32(0), "metadata should be empty");

        // sell side
        uint256 sellingPrice = _getPaymentTokenAmount(firstOrder);
        address nftToken = _getNFTTokenAddress(firstCall);
        uint256 nftTokenID = _getNFTTokenID(firstOrder);

        // buy side
        address paymentToken = _getPaymentTokenAddress(secondCall);
        uint256 buyingPrice = _getPaymentTokenAmount(secondOrder);
        uint256 nftTokenIDPrime = _getNFTTokenID(secondOrder);

        // TODO: support ERC1155, check the nftAmount
        require(sellingPrice == buyingPrice, "selling and buying mismatch");
        require(nftTokenID == nftTokenIDPrime, "nft tokenID mismatch");

        if (paymentToken == address(0)) {
            // if paid with ETH
            require(
                msg.value == buyingPrice,
                "invalid amount of ETH for the purchase"
            );
        } else {
            require(
                dataWarehouse.isAWhitelistedPaymentToken(paymentToken),
                "not a whitelisted payment token"
            );
        }

        return true;
    }

    function _performNFTLiquidityMining(NFTTradeMetadata memory tm)
        internal
        returns (uint256 fr0ntierMined)
    {
        if (!liquidityMiningEnabled) {
            return 0; // do nothing
        }

        if (fr0ntierToken == IFr0ntierToken(address(0))) {
            return 0;
        }

        uint256 priceInWei = msg.value;
        if (priceInWei <= lmp.priceThreshold) {
            return 0; // only purchasing with ETH (and above the specified threshold) can earn Fr0ntier through NFT Liquidity mining
        }

        if (miningOnlyForWhitelistedNFTs) {
            if (
                !(dataWarehouse.isAWhitelistedERC721NFTToken(
                    tm.nftTokenAddress
                ) ||
                    dataWarehouse.isAWhitelistedERC1155NFTToken(
                        tm.nftTokenAddress
                    ))
            ) {
                return 0;
            }
        }

        // TODO: Support TNT-1155
        uint256 highestSellingPriceInWei = dataWarehouse
            .getHighestSellingPriceInWei(
                tm.nftTokenAddress,
                tm.nftTokenID
            );
        if (priceInWei > highestSellingPriceInWei) {
            uint256 lastTradeBlockHeight = dataWarehouse
                .getLastNFTTradeBlockHeight(tm.nftTokenAddress, tm.nftTokenID);
            uint256 blockHeight = block.number;

            uint256 normalizedPriceIncrease = SafeMath.div(
                SafeMath.sub(priceInWei, highestSellingPriceInWei),
                SafeMath.add(lmp.gamma, 1)
            );
            uint256 blockGap = SafeMath.sub(blockHeight, lastTradeBlockHeight);

            // NOTE: We know that log2(normalizedPriceIncrease+1) <= 256, and practically blockGap < 10^10. Thus, if omega < 10^8 and alpha < 10^30,
            //       alpha * log2(normalizedPriceIncrease+1) * omega * blockGap should be at most 2.56 * 10^50 < MAX(uint256) = 1.1579 * 10^77.
            //       Hence, the multiplications below should never overflow. On the other hand, if alpha = 10^26, then the max representable
            //       fr0ntierMined can be as large as 10^26 * 256 * 10^8 * 10^10 / (10^8 * 10^10 + 1000000) = 2.56 * 10^28 > 20 * 10^9 * 10^18 = maxFr0ntierTokenSupplyInWei.
            //       Therefore, by setting proper parameters alpha and omega, the follow calculation allows us to produce any "fr0ntierMined" value
            //       within range [0, maxFr0ntierTokenSupplyInWei].
            fr0ntierMined = SafeMath.mul(
                lmp.alpha,
                ExtMath.log2(SafeMath.add(normalizedPriceIncrease, 1))
            );
            fr0ntierMined = SafeMath.mul(fr0ntierMined, lmp.omega);
            fr0ntierMined = SafeMath.mul(fr0ntierMined, blockGap);
            fr0ntierMined = SafeMath.div(
                fr0ntierMined,
                SafeMath.add(SafeMath.mul(lmp.omega, blockGap), 1000000)
            ); // We use constant 1000000 instead of 1 (as in the whitepaper) for better precision control
            fr0ntierMined = SafeMath.add(fr0ntierMined, lmp.epsilon);
            if (fr0ntierMined > lmp.maxRewardPerTrade) {
                fr0ntierMined = lmp.maxRewardPerTrade;
            }

            dataWarehouse.updateHighestSellingPriceInWei(
                tm.nftTokenAddress,
                tm.nftTokenID,
                priceInWei
            );

            emit CalculateFr0ntierMined(
                lmp.alpha,
                priceInWei,
                highestSellingPriceInWei,
                lmp.gamma,
                lmp.omega,
                blockHeight,
                lastTradeBlockHeight,
                lmp.epsilon,
                lmp.priceThreshold,
                lmp.maxRewardPerTrade
            );
        } else {
            fr0ntierMined = lmp.epsilon;
        }

        fr0ntierToken.mine(tm.buyer, fr0ntierMined);
        emit MinedFr0ntier(tm.buyer, fr0ntierMined);

        return fr0ntierMined;
    }

    function executeCall(
        ProxyRegistryInterface registry,
        address maker,
        Call memory call
    ) internal override returns (bool) {
        /* Assert target exists. */
        require(exists(call.target), "Call target does not exist");

        /* Execute order. */
        return tokenSwapAgent.proxyCall(call.target, call.howToCall, call.data);
    }

    function _chargePlatformFee(
        Order memory firstOrder,
        Call memory firstCall,
        Order memory secondOrder,
        Call memory secondCall
    ) internal virtual override returns (uint256 sellerValue) {
        address nftTokenAddress = _getNFTTokenAddress(firstCall);
        uint256 nftTokenID = _getNFTTokenID(firstOrder);
        bool isAPrimaryMarketSale = _isAPrimaryMarketSale(
            nftTokenAddress,
            nftTokenID
        );

        uint256 platformFeeSplitBasisPoints = secondaryMarketPlatformFeeSplitBasisPoints;
        if (isAPrimaryMarketSale) {
            platformFeeSplitBasisPoints = primaryMarketPlatformFeeSplitBasisPoints;
        }

        if (platformFeeSplitBasisPoints == 0) {
            return msg.value; // do nothing
        }

        require(
            platformFeeSplitBasisPoints <= 10000,
            "invalid platformFeeSplitBasisPoints"
        );

        address erc20PaymentTokenAddr = _getPaymentTokenAddress(secondCall);

        if (erc20PaymentTokenAddr == address(0)) {
            // paid with ETH
            if (msg.value == 0) {
                return 0;
            }

            uint256 platformFeeInETH = SafeMath.div(
                SafeMath.mul(msg.value, platformFeeSplitBasisPoints),
                10000
            );
            sellerValue = SafeMath.sub(msg.value, platformFeeInETH);
            if (platformFeeInETH > 0) {
                platformFeeRecipient.transfer(platformFeeInETH);
            }

            address seller = firstOrder.maker;
            emit ETHSplit(
                seller,
                sellerValue,
                platformFeeRecipient,
                platformFeeInETH
            );

            return sellerValue;
        } else {
            // paid with ERC20 tokens
            require(
                msg.value == 0,
                "msg.value should be zero if the trade is paid in ETH"
            );

            // extract the payment token amount
            uint256 price = _getPaymentTokenAmount(secondOrder);
            if (price == 0) {
                return 0;
            }

            address buyerAddr = secondOrder.maker;
            address sellerAddr = firstOrder.maker;
            uint256 platformFeeInERC20 = SafeMath.div(
                SafeMath.mul(price, platformFeeSplitBasisPoints),
                10000
            );
            bool chargeSuccessful = tokenSwapAgent.transferFee(
                erc20PaymentTokenAddr,
                buyerAddr,
                platformFeeRecipient,
                platformFeeInERC20
            );
            require(chargeSuccessful, "ERC20 payment token transfer failed");

            // adjust the orders and calls since the amount of payment token to be sent to the seller has been deducted
            _adjustOrdersAndCalls(
                firstOrder,
                firstCall,
                secondOrder,
                secondCall,
                buyerAddr,
                sellerAddr,
                price,
                platformFeeInERC20
            );

            return 0;
        }

        return 0;
    }

    function _adjustOrdersAndCalls(
        Order memory firstOrder,
        Call memory firstCall,
        Order memory secondOrder,
        Call memory secondCall,
        address buyerAddr,
        address sellerAddr,
        uint256 price,
        uint256 platformFeeInERC20
    ) internal pure {
        uint256 adjustedPrice = SafeMath.sub(price, platformFeeInERC20);

        (
            address[2] memory firstTokenAddrPair,
            uint256[2] memory firstTokenIDAndPrice
        ) = abi.decode(firstOrder.staticExtradata, (address[2], uint256[2]));
        firstTokenIDAndPrice[1] = adjustedPrice;
        firstOrder.staticExtradata = abi.encode(
            firstTokenAddrPair,
            firstTokenIDAndPrice
        );

        (
            address[2] memory secondTokenAddrPair,
            uint256[2] memory secondTokenIDAndPrice
        ) = abi.decode(secondOrder.staticExtradata, (address[2], uint256[2]));
        secondTokenIDAndPrice[1] = adjustedPrice;
        secondOrder.staticExtradata = abi.encode(
            secondTokenAddrPair,
            secondTokenIDAndPrice
        );

        secondCall.data = abi.encodeWithSignature(
            "transferFrom(address,address,uint256)",
            buyerAddr,
            sellerAddr,
            adjustedPrice
        );
    }

    function _updateNFTTradeBlockHeight(
        address nftTokenAddress,
        uint256 nftTokenID
    ) internal {
        dataWarehouse.updateNFTTradeBlockHeight(nftTokenAddress, nftTokenID);
    }

    function _getPaymentTokenAddress(Call memory call)
        internal
        pure
        returns (address)
    {
        return call.target;
    }

    function _getPaymentTokenAmount(Order memory order)
        internal
        pure
        returns (uint256)
    {
        uint256 amount = abi.decode(
            ArrayUtils.arraySlice(order.staticExtradata, 96, 32),
            (uint256)
        );
        return amount;
    }

    function _getNFTTokenAddress(Call memory call)
        internal
        pure
        returns (address)
    {
        return call.target;
    }

    function _getNFTTokenID(Order memory order)
        internal
        pure
        returns (uint256)
    {
        uint256 tokenID = abi.decode(
            ArrayUtils.arraySlice(order.staticExtradata, 64, 32),
            (uint256)
        );
        return tokenID;
    }

    function _extractNFTTradeMetadata(
        Order memory firstOrder,
        Call memory firstCall,
        Order memory secondOrder,
        Call memory secondCall
    ) internal pure returns (NFTTradeMetadata memory) {
        // sell side
        address nftToken = _getNFTTokenAddress(firstCall);
        uint256 nftTokenID = _getNFTTokenID(firstOrder);

        // buy side
        address paymentToken = _getPaymentTokenAddress(secondCall);
        uint256 buyingPrice = _getPaymentTokenAmount(secondOrder);

        NFTTradeMetadata memory tm;
        tm.seller = firstOrder.maker;
        tm.buyer = secondOrder.maker;
        tm.nftTokenAddress = nftToken;
        tm.nftTokenID = nftTokenID;
        tm.nftAmount = 1; // TODO: support ERC1155
        tm.paymentTokenAddress = paymentToken;
        tm.paymentTokenAmount = buyingPrice;

        return tm;
    }

    function _isAPrimaryMarketSale(address nftTokenAddress, uint256 nftTokenID)
        internal
        returns (bool)
    {
        uint256 lastTradeBlockHeight = dataWarehouse.getLastNFTTradeBlockHeight(
            nftTokenAddress,
            nftTokenID
        );
        bool isAPrimaryMarketSale = (lastTradeBlockHeight == 0);
        return isAPrimaryMarketSale;
    }

    modifier onlySuperAdmin() {
        require(
            msg.sender == superAdmin,
            "only the super admin can perform this action"
        );
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "only the admin can perform this action");
        _;
    }

    modifier onlyAdminOrGovernor() {
        require(
            msg.sender == admin || msg.sender == governor,
            "only the admin can perform this action"
        );
        _;
    }

    modifier onlyWhenUnpaused() {
        require(!paused, "marketplace is paused");
        _;
    }
}
