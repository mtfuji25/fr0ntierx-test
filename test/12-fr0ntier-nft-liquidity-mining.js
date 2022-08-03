const WyvernAtomicizer = artifacts.require('WyvernAtomicizer')
const TokenSwapAgent = artifacts.require('TokenSwapAgent')
const Fr0ntierMarketplace = artifacts.require('Fr0ntierMarketplace')
const Fr0ntierDataWarehouse = artifacts.require('Fr0ntierDataWarehouse')
const StaticMarket = artifacts.require('StaticMarket')
const WyvernRegistry = artifacts.require('WyvernRegistry')
const TestERC20 = artifacts.require('TestERC20')
const TestERC721 = artifacts.require('TestERC721')
const MockFr0ntierToken = artifacts.require('MockFr0ntierToken')

const Web3 = require('web3')
const provider = new Web3.providers.HttpProvider('http://localhost:18888')
const web3 = new Web3(provider)
const { wrap, ZERO_ADDRESS, ZERO_BYTES32, CHAIN_ID } = require('./aux')
const BN = web3.utils.BN

const platformFeeSplitBasisPoints = 1000
const epsilon = new BN('1000000000000000000') // 1 * 10**18, 1 Fr0ntiers
const alpha = new BN('1000000000000000000')
const gamma = new BN('10000000000000').sub(new BN(1))
const omega = new BN('100000');
const priceThreshold = new BN('1500000000000000000') // 1.5*10**18, 1.5 ETH
const maxRewardPerTrade = new BN('1000000000000000000000') // 1000 * 10**18, 1000 Fr0ntier

//
// Note: This test case only works with Gananche since it calls `evm_mine`
//
contract('Fr0ntier-NFT-Liquidity-Mining', (accounts) => {

    const dec18 = new BN('1000000000000000000')

    let deploy = async contracts => Promise.all(contracts.map(contract => contract.new()))

    let deployCoreContracts = async () => {
        superAdmin = accounts[9]
        admin = accounts[8]
        platformFeeRecipient = accounts[7]

        fr0ntierToken = await MockFr0ntierToken.new()
        registry = await WyvernRegistry.new()
        atomicizer = await WyvernAtomicizer.new()
        marketplace = await Fr0ntierMarketplace.new(CHAIN_ID, '0x', superAdmin, admin, platformFeeRecipient)
        tokenSwapAgent = await TokenSwapAgent.new(superAdmin, admin)
        dataWarehouse = await Fr0ntierDataWarehouse.new(superAdmin, admin, ZERO_ADDRESS)
        statici = await StaticMarket.new()

        await marketplace.setFr0ntierToken(fr0ntierToken.address, { from: admin })
        await marketplace.setPrimaryMarketPlatformFeeSplitBasisPoints(platformFeeSplitBasisPoints, { from: admin })
        await marketplace.setSecondaryMarketPlatformFeeSplitBasisPoints(platformFeeSplitBasisPoints, { from: admin })
        await marketplace.setTokenSwapAgent(tokenSwapAgent.address, { from: admin })
        await marketplace.setDataWarehouse(dataWarehouse.address, { from: admin })
        await marketplace.enableNFTLiqudityMining(true, { from: admin })
        await marketplace.updateLiquidityMiningParams(epsilon, alpha, gamma, omega, priceThreshold, maxRewardPerTrade, { from: admin })
        await marketplace.enableLiqudityMiningOnlyForWhitelistedNFTs(false, { from: admin })

        await tokenSwapAgent.setMarketplace(marketplace.address, { from: admin })
        await dataWarehouse.setMarketplace(marketplace.address, { from: admin })
        await registry.grantInitialAuthentication(marketplace.address)

        return { registry, marketplace: wrap(marketplace), tokenSwapAgent, dataWarehouse, atomicizer, statici, fr0ntierToken }
    }

    let mineBlocks = async (numBlocks) => {
        for (let i = 0; i < numBlocks + 1; i++) {
            await web3.currentProvider.send({
                jsonrpc: "2.0",
                method: "evm_mine",
                id: 12345
            }, function (err, result) { });
        }
    }

    let getBlockHeight = async (print) => {
        currentBlockHeight = await web3.eth.getBlockNumber()
        if (print) {
            console.log("current block height:", currentBlockHeight)
        }
        return currentBlockHeight
    }

    let calculateExpectedFr0ntierMined = (currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight) => {
        let numBlocksElapsed = (new BN(currentTradeBlockHeight)).sub(new BN(lastTradeBlockHeight))
        assert.isTrue(numBlocksElapsed.gte(new BN(0)))

        if (currentTradePrice.lte(priceThreshold)) {
            return new BN(0)
        }

        let priceIncrease = (new BN(currentTradePrice)).sub(new BN(highestSellingPriceInThePast))
        if (priceIncrease.lt(new BN(0))) {
            return epsilon
        }

        let normalizedPriceIncrease = priceIncrease.div(gamma.add(new BN(1)))

        // f = ceil(log2(normalizedPriceIncrease + 1))
        let f = new BN(Math.ceil(Math.log(normalizedPriceIncrease.add(new BN(1))) / Math.log(2)))

        // g = 1 - 1000000 / (omega * numBlocksElapsed + 1000000) = omega * numBlocksElapsed / (omega * numBlocksElapsed + 1000000)
        let gNumer = omega.mul(new BN(numBlocksElapsed))
        let gDenom = omega.mul(new BN(numBlocksElapsed)).add(new BN(1000000))

        // fr0ntierMined = alpha * f * g + epsilon = alpha * f * gNumer / gDenom + epsilon
        let fr0ntierMined = alpha.mul(f).mul(gNumer).div(gDenom)
        fr0ntierMined = fr0ntierMined.add(epsilon)

        if (fr0ntierMined.gt(maxRewardPerTrade)) {
            fr0ntierMined = maxRewardPerTrade
        }

        return fr0ntierMined
    }

    let prepareForNFTTrade = async (marketplace, erc721, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, price) => {
        const erc721c = new web3.eth.Contract(erc721.abi, erc721.address)

        // NFT Seller
        // Important note: should use different salt strings for different trades
        const selectorOne = web3.eth.abi.encodeFunctionSignature('ERC721ForETH(bytes,address[7],uint8[2],uint256[6],bytes,bytes)')
        const paramsOne = web3.eth.abi.encodeParameters(['address[2]', 'uint256[2]'], [[erc721.address, "0x0000000000000000000000000000000000000000"], [nftTokenID, price.toString()]])
        const one = { registry: registry.address, maker: nftSeller, staticTarget: statici.address, staticSelector: selectorOne, staticExtradata: paramsOne, maximumFill: 1, listingTime: '0', expirationTime: '10000000000', salt: nftSellerSalt }
        const firstData = erc721c.methods.transferFrom(nftSeller, nftBuyer, nftTokenID).encodeABI()
        const firstCall = { target: erc721.address, howToCall: 0, data: firstData }
        let sigOne = await marketplace.sign(one, nftSeller) // in an actual implementation, this should be signed by the seller

        // NFT Buyer, target: "0x0000000000000000000000000000000000000000" indicates buying with ETH
        // Important note: should use different salt strings for different trades
        const selectorTwo = web3.eth.abi.encodeFunctionSignature('ETHForERC721(bytes,address[7],uint8[2],uint256[6],bytes,bytes)')
        const paramsTwo = web3.eth.abi.encodeParameters(['address[2]', 'uint256[2]'], [["0x0000000000000000000000000000000000000000", erc721.address], [nftTokenID, price.toString()]])
        const two = { registry: registry.address, maker: nftBuyer, staticTarget: statici.address, staticSelector: selectorTwo, staticExtradata: paramsTwo, maximumFill: 1, listingTime: '0', expirationTime: '10000000000', salt: nftBuyerSalt }
        const secondCall = { target: "0x0000000000000000000000000000000000000000", howToCall: 0, data: "0x" }
        let sigTwo = await marketplace.sign(two, nftBuyer) // in an actual implementation, this should be signed by the buyer

        return { one, sigOne, firstCall, two, sigTwo, secondCall }
    }

    let verifyTradeOutcome = async (erc721, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, print) => {
        let tokenOwner = await erc721.ownerOf(nftTokenID)
        assert.equal(tokenOwner, nftBuyer, 'Incorrect token owner')

        let buyerEthBalance = await web3.eth.getBalance(nftBuyer)
        let sellerEthBalance = await web3.eth.getBalance(nftSeller)
        let platformFeeRecipientEthBalance = await web3.eth.getBalance(platformFeeRecipient)

        let currentTradePriceBN = web3.utils.toBN(currentTradePrice)
        let expectedPlatformFeeBN = currentTradePriceBN.mul(new BN(platformFeeSplitBasisPoints)).div(new BN(10000))
        let expectedNFTSellerEarningBN = currentTradePriceBN.sub(expectedPlatformFeeBN)

        let sellerEthBalanceB4TradeBN = web3.utils.toBN(sellerEthBalanceB4Trade)
        let sellerEthBalanceBN = web3.utils.toBN(sellerEthBalance)

        let buyerEthBalanceB4TradeBN = web3.utils.toBN(buyerEthBalanceB4Trade)
        let buyerEthBalanceBN = web3.utils.toBN(buyerEthBalance)

        let platformFeeRecipientEthBalanceBN = web3.utils.toBN(platformFeeRecipientEthBalance)
        let platformFeeRecipientEthBalanceB4TradeBN = web3.utils.toBN(platformFeeRecipientEthBalanceB4Trade)

        let sellerEthBalanceIncreaseBN = sellerEthBalanceBN.sub(sellerEthBalanceB4TradeBN)
        let buyerEthBalanceDecreaseBN = buyerEthBalanceB4TradeBN.sub(buyerEthBalanceBN)
        let platformFeeRecipientEthBalanceIncreaseBN = platformFeeRecipientEthBalanceBN.sub(platformFeeRecipientEthBalanceB4TradeBN)

        if (print) {
            console.log('sellerEthBalanceIncreaseBN:', sellerEthBalanceIncreaseBN.toString())
            console.log('expectedNFTSellerEarningBN:', expectedNFTSellerEarningBN.toString())

            console.log('buyerEthBalanceDecreaseBN :', buyerEthBalanceDecreaseBN.toString())
            console.log('currentTradePriceBN       :', currentTradePriceBN.toString())

            console.log('platformFeeRecipientEthBalanceIncreaseBN:', platformFeeRecipientEthBalanceIncreaseBN.toString())
            console.log('expectedPlatformFeeBN                   :', expectedPlatformFeeBN.toString())
        }

        assert.equal(sellerEthBalanceIncreaseBN.toString(), expectedNFTSellerEarningBN.toString(), 'Incorrect amount of ETH transferred')
        assert.isTrue(buyerEthBalanceDecreaseBN.gt(currentTradePriceBN), 'Incorrect amount of ETH deducted from the buyer') // The buyer also needs to pay for the gas fee
        assert.equal(platformFeeRecipientEthBalanceIncreaseBN.toString(), expectedPlatformFeeBN.toString(), 'Incorrect platform fee transferred')
    }

    let verifyLiquidityMiningResults = async (nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, print) => {
        let sellerFr0ntierBalance = await fr0ntierToken.balanceOf(nftSeller)
        let buyerFr0ntierBalance = await fr0ntierToken.balanceOf(nftBuyer)
        let buyerFr0ntierIncrease = buyerFr0ntierBalance.sub(new BN(buyerFr0ntierBalanceB4Trade))

        assert.isTrue(sellerFr0ntierBalance.sub(sellerFr0ntierBalanceB4Trade).cmp(new BN('0')) == 0) // seller's Fr0ntier balance should not change

        let expectedFr0ntierMinedInWei = calculateExpectedFr0ntierMined(currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight)

        if (print) {
            console.log("buyerFr0ntierIncrease:", buyerFr0ntierIncrease.toString(), "Fr0ntierWei")
            console.log("expectedFr0ntierMined:", expectedFr0ntierMinedInWei.toString(), "Fr0ntierWei")

            expectedFr0ntierMined = expectedFr0ntierMinedInWei.mul(new BN(100000000)).div(dec18).toNumber() / 100000000
            console.log("expectedFr0ntierMined:", expectedFr0ntierMined.toString(), "Fr0ntier")
        }

        let diffInFr0ntierWei = buyerFr0ntierIncrease.sub(expectedFr0ntierMinedInWei)
        let diffInFr0ntier = diffInFr0ntierWei.mul(new BN(100000000)).div(dec18).toNumber() / 100000000

        if (print) {
            console.log("diffInFr0ntierWei    :", diffInFr0ntierWei.toString(), "Fr0ntierWei")
            console.log("diffInFr0ntier       :", diffInFr0ntier, "Fr0ntier")
        }

        // expectedFr0ntierMined - maxDiff < buyerFr0ntierIncrease < expectedFr0ntierMined + maxDiff
        assert.isTrue(buyerFr0ntierIncrease.gt(expectedFr0ntierMinedInWei.sub(maxDiff)))
        assert.isTrue(buyerFr0ntierIncrease.lt(expectedFr0ntierMinedInWei.add(maxDiff)))
    }

    let getSalt = () => {
        let epochTimeMilli = (new Date()) / 1
        return epochTimeMilli.toString()
    }

    it('NFT Liquidity Mining Basic Test', async () => {
        let nftTokenID = 9912879027088
        let currentTradePrice = (new BN(122)).mul(dec18)
        let highestSellingPriceInThePast = new BN(0)
        let nftSeller = accounts[5]
        let nftBuyer = accounts[6]
        let platformFeeRecipient = accounts[7]

        let { registry, marketplace, tokenSwapAgent, dataWarehouse, atomicizer, statici, fr0ntierToken } = await deployCoreContracts()
        let tokenSwapAgentAddr = tokenSwapAgent.address
        let [erc721] = await deploy([TestERC721])

        await erc721.mint(nftSeller, nftTokenID)

        // The seller puts the NFT on sale
        await erc721.setApprovalForAll(tokenSwapAgentAddr, true, { from: nftSeller })

        // The NFT trade
        let lastTradeBlockHeight = new BN(0)
        await mineBlocks(10) // advance a few blocks
        let currentTradeBlockHeight = await getBlockHeight(true)

        let buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
        let sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
        let platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
        let sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
        let buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

        let nftSellerSalt = getSalt()
        let nftBuyerSalt = getSalt()
        let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
        await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })

        await verifyTradeOutcome(erc721, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)
        let maxDiff = new BN('100000000000000000') // 10^17 Fr0ntierWei = 0.1 Fr0ntier
        await verifyLiquidityMiningResults(nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, true)
    })

    it('NFT Liquidity Mining Multiple Trades', async () => {
        let nftTokenID = 9912879027088

        let tradePrice1 = (new BN(2)).mul(dec18)
        let tradePrice2 = (new BN(300)).mul(dec18)     // price increases
        let tradePrice3 = (new BN(103)).mul(dec18)     // price decreases
        let tradePrice4 = (new BN(288)).mul(dec18)     // price increases, but less than the highest traded price in history
        let tradePrice5 = (new BN(1999999)).mul(dec18) // price increases, and surpasses the highest traded price in history
        let tradePrice6 = (new BN(1)).mul(dec18)       // not eligible to receive Fr0ntier since it is lower than the priceThreshold

        let user1 = accounts[1]
        let user2 = accounts[2]
        let user3 = accounts[3]
        let user4 = accounts[4]

        let platformFeeRecipient = accounts[7]

        let { registry, marketplace, tokenSwapAgent, dataWarehouse, atomicizer, statici, fr0ntierToken } = await deployCoreContracts()
        let tokenSwapAgentAddr = tokenSwapAgent.address
        let [erc721] = await deploy([TestERC721])

        await erc721.mint(user1, nftTokenID)

        await erc721.setApprovalForAll(tokenSwapAgentAddr, true, { from: user1 })
        await erc721.setApprovalForAll(tokenSwapAgentAddr, true, { from: user2 })
        await erc721.setApprovalForAll(tokenSwapAgentAddr, true, { from: user3 })
        await erc721.setApprovalForAll(tokenSwapAgentAddr, true, { from: user4 })

        //
        // The First Trade
        //

        console.log("-------------------------------------------------------------")
        console.log("NFT Trade")
        console.log("")


        nftSeller = user1
        nftBuyer = user2
        currentTradePrice = tradePrice1
        highestSellingPriceInThePast = new BN(0)
        lastTradeBlockHeight = new BN(0)
        await mineBlocks(100) // advance a few blocks
        currentTradeBlockHeight = await getBlockHeight(true)
        console.log("lastTradeBlockHeight:", lastTradeBlockHeight.toString(), "currentTradeBlockHeight:", currentTradeBlockHeight.toString())

        buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
        sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
        platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
        sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
        buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

        nftSellerSalt = getSalt()
        nftBuyerSalt = getSalt()
        {
            let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
            await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })
        }
        await verifyTradeOutcome(erc721, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)

        maxDiff = new BN('100000000000000000') // 10^17 Fr0ntierWei = 0.1 Fr0ntier
        await verifyLiquidityMiningResults(nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, true)

        console.log("-------------------------------------------------------------")
        console.log("")

        //
        // The Second Trade
        //

        console.log("-------------------------------------------------------------")
        console.log("NFT Trade")
        console.log("")

        nftSeller = user2
        nftBuyer = user3
        currentTradePrice = tradePrice2
        highestSellingPriceInThePast = tradePrice1
        lastTradeBlockHeight = currentTradeBlockHeight
        await mineBlocks(5) // advance a few blocks
        currentTradeBlockHeight = await getBlockHeight(true)
        console.log("lastTradeBlockHeight:", lastTradeBlockHeight.toString(), "currentTradeBlockHeight:", currentTradeBlockHeight.toString())

        buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
        sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
        platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
        sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
        buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

        nftSellerSalt = getSalt()
        nftBuyerSalt = getSalt()
        {
            let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
            await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })
        }
        await verifyTradeOutcome(erc721, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)

        maxDiff = new BN('2000000000000000000') // 2 Fr0ntier, small block gaps between the two trades, smart contract and JS reading on the block gap might different. So larger maxDiff
        await verifyLiquidityMiningResults(nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, true)

        console.log("-------------------------------------------------------------")
        console.log("")

        //
        // The Third Trade
        //

        console.log("-------------------------------------------------------------")
        console.log("NFT Trade")
        console.log("")

        nftSeller = user3
        nftBuyer = user4
        currentTradePrice = tradePrice3
        highestSellingPriceInThePast = tradePrice2
        lastTradeBlockHeight = currentTradeBlockHeight
        await mineBlocks(300) // advance a few blocks
        currentTradeBlockHeight = await getBlockHeight(true)
        console.log("lastTradeBlockHeight:", lastTradeBlockHeight.toString(), "currentTradeBlockHeight:", currentTradeBlockHeight.toString())

        buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
        sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
        platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
        sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
        buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

        nftSellerSalt = getSalt()
        nftBuyerSalt = getSalt()
        {
            let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
            await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })
        }
        await verifyTradeOutcome(erc721, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)

        maxDiff = new BN('1') // 1 Fr0ntierWei, very small error tolerance since this trade is expected to mine exactly epsilon amount of Fr0ntier since the current trade price doesn't exceed the historical height
        await verifyLiquidityMiningResults(nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, true)

        console.log("-------------------------------------------------------------")
        console.log("")

        //
        // The Fourth Trade
        //

        console.log("-------------------------------------------------------------")
        console.log("NFT Trade")
        console.log("")

        nftSeller = user4
        nftBuyer = user1
        currentTradePrice = tradePrice4
        highestSellingPriceInThePast = tradePrice2
        lastTradeBlockHeight = currentTradeBlockHeight
        await mineBlocks(15) // advance a few blocks
        currentTradeBlockHeight = await getBlockHeight(true)
        console.log("lastTradeBlockHeight:", lastTradeBlockHeight.toString(), "currentTradeBlockHeight:", currentTradeBlockHeight.toString())

        buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
        sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
        platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
        sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
        buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

        nftSellerSalt = getSalt()
        nftBuyerSalt = getSalt()
        {
            let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
            await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })
        }
        await verifyTradeOutcome(erc721, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)

        maxDiff = new BN('1') // 1 Fr0ntierWei, very small error tolerance since this trade is expected to mine exactly epsilon amount of Fr0ntier since the current trade price doesn't exceed the historical height
        await verifyLiquidityMiningResults(nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, true)

        console.log("-------------------------------------------------------------")
        console.log("")

        //
        // The Fifth Trade
        //

        console.log("-------------------------------------------------------------")
        console.log("NFT Trade")
        console.log("")

        nftSeller = user1
        nftBuyer = user3
        currentTradePrice = tradePrice5
        highestSellingPriceInThePast = tradePrice2
        lastTradeBlockHeight = currentTradeBlockHeight
        await mineBlocks(23) // advance a few blocks
        currentTradeBlockHeight = await getBlockHeight(true)
        console.log("lastTradeBlockHeight:", lastTradeBlockHeight.toString(), "currentTradeBlockHeight:", currentTradeBlockHeight.toString())

        buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
        sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
        platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
        sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
        buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

        nftSellerSalt = getSalt()
        nftBuyerSalt = getSalt()
        {
            let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
            await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })
        }
        await verifyTradeOutcome(erc721, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)

        maxDiff = new BN('100000000000000000') // 10^17 Fr0ntierWei = 0.1 Fr0ntier
        await verifyLiquidityMiningResults(nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, true)

        console.log("-------------------------------------------------------------")
        console.log("")

        //
        // The Sixth Trade
        //

        console.log("-------------------------------------------------------------")
        console.log("NFT Trade")
        console.log("")

        nftSeller = user3
        nftBuyer = user1
        currentTradePrice = tradePrice6
        highestSellingPriceInThePast = tradePrice5
        lastTradeBlockHeight = currentTradeBlockHeight
        await mineBlocks(10) // advance a few blocks
        currentTradeBlockHeight = await getBlockHeight(true)
        console.log("lastTradeBlockHeight:", lastTradeBlockHeight.toString(), "currentTradeBlockHeight:", currentTradeBlockHeight.toString())

        buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
        sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
        platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
        sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
        buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

        nftSellerSalt = getSalt()
        nftBuyerSalt = getSalt()
        {
            let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
            await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })
        }
        await verifyTradeOutcome(erc721, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)

        maxDiff = new BN('100000000000000000') // 10^17 Fr0ntierWei = 0.1 Fr0ntier
        await verifyLiquidityMiningResults(nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, true)

        buyerFr0ntierBalance = await fr0ntierToken.balanceOf(nftBuyer)
        assert.equal(buyerFr0ntierBalance.toString(), buyerFr0ntierBalanceB4Trade.toString(), 'The buyer should not mine any Fr0ntier since the trading price is lower than the priceThreshold')

        console.log("-------------------------------------------------------------")
        console.log("")
    })

    it('NFT Liquidity Mining Whitelisted ERC721 only', async () => {
        let nftTokenID = 9912879027088
        let currentTradePrice = (new BN(122)).mul(dec18)
        let highestSellingPriceInThePast = new BN(0)
        let nftSeller = accounts[5]
        let nftBuyer = accounts[6]
        let platformFeeRecipient = accounts[7]
        let whitelister = accounts[4]
        let admin = accounts[8]

        let { registry, marketplace, tokenSwapAgent, dataWarehouse, atomicizer, statici, fr0ntierToken } = await deployCoreContracts()
        await dataWarehouse.setWhitelister(whitelister, { from: admin })
        await marketplace.inst.enableLiqudityMiningOnlyForWhitelistedNFTs(true, { from: admin })

        let tokenSwapAgentAddr = tokenSwapAgent.address

        // ------ The NFT trade for the whitelisted ERC721 ------ //
        {
            let [erc721Whitelisted] = await deploy([TestERC721])
            await erc721Whitelisted.mint(nftSeller, nftTokenID)

            // The seller puts the NFT on sale
            await erc721Whitelisted.setApprovalForAll(tokenSwapAgentAddr, true, { from: nftSeller })
            await dataWarehouse.whitelistERC721NFTToken(erc721Whitelisted.address, true, { from: whitelister })

            let lastTradeBlockHeight = new BN(0)
            await mineBlocks(10) // advance a few blocks
            let currentTradeBlockHeight = await getBlockHeight(true)

            let buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
            let sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
            let platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
            let sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
            let buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

            let nftSellerSalt = getSalt()
            let nftBuyerSalt = getSalt()
            let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721Whitelisted, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
            await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })

            await verifyTradeOutcome(erc721Whitelisted, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)
            let maxDiff = new BN('100000000000000000') // 10^17 Fr0ntierWei = 0.1 Fr0ntier
            await verifyLiquidityMiningResults(nftSeller, nftBuyer, sellerFr0ntierBalanceB4Trade, buyerFr0ntierBalanceB4Trade, currentTradePrice, highestSellingPriceInThePast, currentTradeBlockHeight, lastTradeBlockHeight, maxDiff, true)
        }

        // ------ The NFT trade for the ERC721 not whitelisted ------ //
        {
            let [erc721NotWhitelisted] = await deploy([TestERC721])
            await erc721NotWhitelisted.mint(nftSeller, nftTokenID)

            // The seller puts the NFT on sale
            await erc721NotWhitelisted.setApprovalForAll(tokenSwapAgentAddr, true, { from: nftSeller })

            lastTradeBlockHeight = new BN(0)
            await mineBlocks(100) // advance a few blocks
            currentTradeBlockHeight = await getBlockHeight(true)

            let buyerEthBalanceB4Trade = await web3.eth.getBalance(nftBuyer)
            let sellerEthBalanceB4Trade = await web3.eth.getBalance(nftSeller)
            let platformFeeRecipientEthBalanceB4Trade = await web3.eth.getBalance(platformFeeRecipient)
            let sellerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftSeller)
            let buyerFr0ntierBalanceB4Trade = await fr0ntierToken.balanceOf(nftBuyer)

            let nftSellerSalt = getSalt()
            let nftBuyerSalt = getSalt()
            let { one, sigOne, firstCall, two, sigTwo, secondCall } = await prepareForNFTTrade(marketplace, erc721NotWhitelisted, nftSeller, nftSellerSalt, nftBuyer, nftBuyerSalt, nftTokenID, currentTradePrice)
            await marketplace.tradeNFT(one, sigOne, firstCall, two, sigTwo, secondCall, ZERO_BYTES32, { from: nftBuyer, value: currentTradePrice })
            await verifyTradeOutcome(erc721NotWhitelisted, nftSeller, nftBuyer, nftTokenID, currentTradePrice, sellerEthBalanceB4Trade, buyerEthBalanceB4Trade, platformFeeRecipientEthBalanceB4Trade, true)

            let sellerFr0ntierBalance = await fr0ntierToken.balanceOf(nftSeller)
            let buyerFr0ntierBalance = await fr0ntierToken.balanceOf(nftBuyer)

            assert.isTrue(sellerFr0ntierBalance.sub(sellerFr0ntierBalanceB4Trade).cmp(new BN('0')) == 0) // seller's Fr0ntier balance should not change
            assert.isTrue(buyerFr0ntierBalance.sub(buyerFr0ntierBalanceB4Trade).cmp(new BN('0')) == 0) // no Fr0ntier mined for the NFT that is not whitelisted

            print = true
            if (print) {
                console.log("sellerFr0ntierBalanceB4Trade:", sellerFr0ntierBalanceB4Trade.toString(), "Fr0ntierWei")
                console.log("buyerFr0ntierBalanceB4Trade :", buyerFr0ntierBalanceB4Trade.toString(), "Fr0ntierWei")
                console.log("sellerFr0ntierBalance       :", sellerFr0ntierBalance.toString(), "Fr0ntierWei")
                console.log("buyerFr0ntierBalance        :", buyerFr0ntierBalance.toString(), "Fr0ntierWei")
            }
        }
    })
})
