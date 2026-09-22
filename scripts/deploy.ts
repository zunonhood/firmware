import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";

const { ethers, networkName } = await network.create();

async function deploy(name: string, args: unknown[] = []) {
  const factory = await ethers.getContractFactory(name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

const activeNetwork = await ethers.provider.getNetwork();
const chainId = Number(activeNetwork.chainId);

if (![4663, 46630, 31337].includes(chainId)) {
  throw new Error("Unsupported chain. Use Robinhood Chain mainnet, testnet, or local Hardhat.");
}

const [deployer] = await ethers.getSigners();
if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required for a public network.");

console.log("Network:", networkName);
console.log("Deployer:", deployer.address);
console.log("Chain ID:", chainId);

const registry = await deploy("ChipRegistry");
const kernel = await deploy("PermissionKernel", [await registry.getAddress()]);
const receipts = await deploy("ExecutionReceiptRegistry");
const router = await deploy("RevenueRouter", [await receipts.getAddress()]);

const deployment = {
  chainId,
  deployedAt: new Date().toISOString(),
  deployer: deployer.address,
  contracts: {
    ChipRegistry: await registry.getAddress(),
    PermissionKernel: await kernel.getAddress(),
    ExecutionReceiptRegistry: await receipts.getAddress(),
    RevenueRouter: await router.getAddress()
  }
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "deployments");
fs.mkdirSync(outputDir, { recursive: true });
const label = chainId === 4663 ? "robinhood-mainnet" :
  chainId === 46630 ? "robinhood-testnet" : "local";
const output = path.join(outputDir, label + ".json");
fs.writeFileSync(output, JSON.stringify(deployment, null, 2) + "\n");
console.log("Deployment manifest:", output);
console.log(JSON.stringify(deployment, null, 2));