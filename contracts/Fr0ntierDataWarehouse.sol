pragma abicoder v2;
pragma solidity 0.7.5;

/**
 * The Fr0ntierDataWarehouse stores critical data from the marketplace, including
 * the NFT sales record, the whitelisted tokens, etc. By decoupling the data warehouse
 * from the marketplace, we allow potentially protocol upgrades which change the marketplace
 * implementation while retaining essential data store in the warehouse
 */
contract Fr0ntierDataWarehouse {
    /// @notice The super admin address
    address public superAdmin;

    /// @notice The admin address
    address public admin;

    /// @notice The whitelister address
    address public whitelister;

    /// @notice the marketplace address
    address public marketplace;

    /// @notice map[NFTAddress][TokenID] => Highest sale price in Wei
    /// for ERC721, it represents the highest historical transaction value of the NFT token with the specified tokenID
    /// for ERC1155, it represents the highest historical transaction value of a single (i.e. value = 1) NFT token with the specified tokenID
    mapping(address => mapping(uint256 => uint256))
        public highestSellingPriceInWei;

    /// @notice map[NFTAddress][TokenID] => NFTTradeBlockHeight
    mapping(address => mapping(uint256 => uint256)) public tradeBlockHeightMap;

    /// @notice whitelisted ERC20 payment tokens (i.e. stablecoins)
    mapping(address => bool) public whitelistedERC20PaymentTokenMap;

    /// @notice whitelisted ERC721 NFT tokens for liquidity mining
    mapping(address => bool) public whitelistedERC721NFTTokenMap;

    /// @notice whitelisted ERC1155 NFT tokens for liquidity mining
    mapping(address => bool) public whitelistedERC1155NFTTokenMap;

    /// @notice An event thats emitted when the super admin address is changed
    event SuperAdminChanged(address superAdmin, address newSuperAdmin);

    /// @notice An event thats emitted when the admin address is changed
    event AdminChanged(address admin, address newAdmin);

    /// @notice An event thats emitted when the whitelister address is changed
    event WhitelisterChanged(address whitelister, address newWhitelister);

    /**
     * @notice Construct a new Fr0ntier token
     * @param superAdmin_ The account with super admin permission
     * @param admin_ The account with admin permission
     */
    constructor(
        address superAdmin_,
        address admin_,
        address whitelister_
    ) public {
        superAdmin = superAdmin_;
        emit SuperAdminChanged(address(0), superAdmin);
        admin = admin_;
        emit AdminChanged(address(0), admin);
        whitelister = whitelister_;
        emit WhitelisterChanged(address(0), whitelister);
    }

    /**
     * @notice Change the admin address
     * @param superAdmin_ The address of the new super admin
     */
    function setSuperAdmin(address superAdmin_) external onlySuperAdmin {
        emit SuperAdminChanged(superAdmin, superAdmin_);
        superAdmin = superAdmin_;
    }

    /**
     * @notice Change the admin address
     * @param admin_ The address of the new admin
     */
    function setAdmin(address admin_) external onlySuperAdmin {
        emit AdminChanged(admin, admin_);
        admin = admin_;
    }

    /**
     * @notice Change the whitelister address
     * @param whitelister_ The address of the new whitelister
     */
    function setWhitelister(address whitelister_) external onlyAdmin {
        emit WhitelisterChanged(whitelister, whitelister_);
        whitelister = whitelister_;
    }

    /**
     * @notice Change the marketplace address
     * @param marketplace_ The address of the new marketplace
     */
    function setMarketplace(address marketplace_) external onlyAdmin {
        marketplace = marketplace_;
    }

    function getHighestSellingPriceInWei(address nftAddr, uint256 tokenID)
        public
        view
        returns (uint256)
    {
        return highestSellingPriceInWei[nftAddr][tokenID];
    }

    function updateHighestSellingPriceInWei(
        address nftAddr,
        uint256 tokenID,
        uint256 newHigestPrice
    ) public onlyMarketplace {
        uint256 currHighestPrice = getHighestSellingPriceInWei(
            nftAddr,
            tokenID
        );
        require(
            newHigestPrice > currHighestPrice,
            "the new highest price needs to be strictly higher than the current higest"
        );
        highestSellingPriceInWei[nftAddr][tokenID] = newHigestPrice;
    }

    function updateNFTTradeBlockHeight(address nftAddr, uint256 tokenID)
        public
        onlyMarketplace
    {
        tradeBlockHeightMap[nftAddr][tokenID] = block.number;
    }

    function getLastNFTTradeBlockHeight(address nftAddr, uint256 tokenID)
        public
        view
        returns (uint256)
    {
        return tradeBlockHeightMap[nftAddr][tokenID];
    }

    function isAWhitelistedPaymentToken(address tokenAddr)
        public
        view
        returns (bool)
    {
        return whitelistedERC20PaymentTokenMap[tokenAddr];
    }

    function whitelistPaymentToken(address tokenAddr, bool isWhitelisted)
        public
        onlyWhitelister
    {
        whitelistedERC20PaymentTokenMap[tokenAddr] = isWhitelisted;
    }

    function isAWhitelistedERC721NFTToken(address tokenAddr)
        public
        view
        returns (bool)
    {
        return whitelistedERC721NFTTokenMap[tokenAddr];
    }

    function whitelistERC721NFTToken(address tokenAddr, bool isWhitelisted)
        public
        onlyWhitelister
    {
        whitelistedERC721NFTTokenMap[tokenAddr] = isWhitelisted;
    }

    function isAWhitelistedERC1155NFTToken(address tokenAddr)
        public
        view
        returns (bool)
    {
        return whitelistedERC1155NFTTokenMap[tokenAddr];
    }

    function whitelistERC1155NFTToken(address tokenAddr, bool isWhitelisted)
        public
        onlyWhitelister
    {
        whitelistedERC1155NFTTokenMap[tokenAddr] = isWhitelisted;
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

    modifier onlyWhitelister() {
        require(
            msg.sender == whitelister,
            "only the whitelister can perform this action"
        );
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
