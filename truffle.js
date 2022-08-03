const HDWalletProvider = require('@truffle/hdwallet-provider');
const dotenv = require('dotenv');
dotenv.config();

const PRIVATE_KEY_RINKEBY = process.env.PRIVATE_KEY_RINKEBY || null;
const PRIVATE_KEY_MAINNET = process.env.PRIVATE_KEY_MAINNET || null;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const INFURA_PROJECT_ID = process.env.INFURA_PROJECT_ID;

module.exports = {
  mocha: {
    enableTimeouts: false,
    before_timeout: 480000
  },

  compilers: {
    solc: {
      version: "0.7.5",
      settings: {
        optimizer: {
          enabled: true,
          runs: 750
        }
      }
    }
  },

  networks: {
    ganache: {
      host: "localhost",
      port: 18888,
      network_id: 366,
    },
    rinkeby: {
      provider: function () {
        return new HDWalletProvider([PRIVATE_KEY_RINKEBY], `wss://rinkeby.infura.io/ws/v3/${INFURA_PROJECT_ID}`);
      },
      network_id: 4,
      gas: 16000000,
      gasPrice: 30000000000,
      skipDryRun: true,
      networkCheckTimeout: 100000000,
      timeoutBlocks: 200,
    },
    mainnet: {
      provider: function () {
        return new HDWalletProvider([PRIVATE_KEY_MAINNET], `wss://mainnet.infura.io/ws/v3/${INFURA_PROJECT_ID}`);
      },
      network_id: 1,
      skipDryRun: true,
      networkCheckTimeout: 100000000,
      timeoutBlocks: 200,
    },
  },
  api_keys: {
    etherscan: ETHERSCAN_API_KEY
  },
  plugins: ['solidity-coverage', 'truffle-contract-size', 'truffle-plugin-verify'],
};