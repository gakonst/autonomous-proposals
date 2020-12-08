// Script for deploying a Uniswap autonomous proposal
// Run with MULTISIG set to your multisig's address and AMOUNT to the UNI amount in decimal
// Run with TESTING=1 and `hardhat node --fork` to test against mainnet
const ethers = require('ethers')

const MULTISIG = process.env.MULTISIG || "0x0000000000000000000000000000000000000001" // TODO: Remove
const AMOUNT = process.env.AMOUNT || 100
const URL = process.env.URL || "http://localhost:8545"
const provider = new ethers.providers.JsonRpcProvider(URL)

const CONTRACTS = require("./.build/contracts.json")
const CrowdProposal = CONTRACTS.contracts['contracts/CrowdProposal.sol:CrowdProposal']
const GOVERNOR_ABI = CONTRACTS.contracts['tests/contracts/GovernorAlpha.sol:GovernorAlpha'].abi

const DESCRIPTION="https://snapshot.page/#/uniswap/proposal/QmQJuW88TbKzMLtEhWC7HkSrUWdF5FVsdsLvhfAogkzyqn"
const UNI="0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"
const GOVERNOR="0x5e4be8Bc9637f0EAA1A755019e06A68ce081D58F"
const VALUES=[0]

const UNI_ABI = [
    "function transfer(address,uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function delegate(address)",
]
let token = new ethers.Contract(UNI, UNI_ABI)
const data = token.interface.encodeFunctionData(
    "transfer",
    [MULTISIG, AMOUNT],
)

// Author is the multisig
const AUTHOR=MULTISIG
// Receiver is the Uniswap token
const TARGETS=[UNI]
// ERC20 transfer
const SIGNATURES=["transfer(address,uint256)"]
// ABI Encoded: Multisig address + amount
const CALLDATAS=["0x" + data.slice(10)]

const args = [
    AUTHOR,
    TARGETS,
    VALUES,
    SIGNATURES,
    CALLDATAS,
    DESCRIPTION,
    UNI,
    GOVERNOR,
]

;(async () => {
  const signer = process.env.KEY ? new ethers.Wallet(procss.env.KEY, provider) : provider.getSigner()
  const factory = new ethers.ContractFactory(CrowdProposal.abi, CrowdProposal.bin, signer)
  console.log("Deploying with args", args)
  const contract = await factory.deploy(...args)
  const receipt = await contract.deployTransaction.wait()
  console.log("Contract deployed at", receipt.contractAddress)

  // this only works with hardhat as the testing env
  if (process.env.TESTING) {
      const governor = new ethers.Contract(GOVERNOR, GOVERNOR_ABI, signer)

      // https://etherscan.io/token/0x1f9840a85d5af5bf1d1762f925bdaddc4201f984#balances
      const WHALES = [
          "0x9f41cecc435101045ea9f41d4ee8c5353f77e5d5",
          "0x662d905a1795ffdf8cfab0abe670dbff3a9fd247",
      ]

      for (const addr of WHALES) {
        await provider.send("hardhat_impersonateAccount", [addr])
        const delegate = provider.getSigner(addr)
        token = token.connect(delegate)
        const tx = await token.delegate(contract.address)
        await tx.wait()
        console.log("Delegated", addr)
      }

      // create the proposal with our votes
      await (await contract.propose()).wait()
      const proposalId = await contract.govProposalId()

      // mine a block so that voting starts
      await provider.send("evm_mine", [])

      // vote (others will also need to vote on the proposal if they did not
      // delegate to us
      await (await contract.vote()).wait()
      
      // advance 7 days (this takes a while...)
      const delay = await governor.votingPeriod()
      for (let i = 0 ; i < delay.add(1).toNumber(); i++) {
        await provider.send("evm_mine", [])
      }

      // queue the proposal
      await (await governor.queue(proposalId)).wait()

      // wait out the timelock delay
      await provider.send("evm_increaseTime", [172800])
      await provider.send("evm_mine", [])

      // execute it
      const before = await token.balanceOf(MULTISIG)
      await (await governor.execute(proposalId)).wait()

      const balance = await token.balanceOf(MULTISIG)
      console.log("Multisig balance", balance.toString(), "correct", balance.sub(before).eq(AMOUNT))
  }
})();
