import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const { ethers } = await network.create();

async function expectRevert(action) {
  let reverted = false;
  try {
    await action();
  } catch {
    reverted = true;
  }
  assert.equal(reverted, true, "expected transaction to revert");
}

describe("firmware protocol", function () {
  async function deployCore() {
    const [owner, operator, reporter, publisher, executor, protocol] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ChipRegistry");
    const registry = await Registry.connect(publisher).deploy();
    await registry.waitForDeployment();

    const Kernel = await ethers.getContractFactory("PermissionKernel");
    const kernel = await Kernel.deploy(await registry.getAddress());
    await kernel.waitForDeployment();

    const Machine = await ethers.getContractFactory("MachineAccount");
    const machine = await Machine.deploy(owner.address, await kernel.getAddress());
    await machine.waitForDeployment();

    const Target = await ethers.getContractFactory("TestTarget");
    const target = await Target.deploy();
    await target.waitForDeployment();

    return { owner, operator, reporter, publisher, executor, protocol, registry, kernel, machine, target };
  }

  it("publishes immutable revisions and supports explicit revocation", async function () {
    const { publisher, registry } = await deployCore();
    const chipId = ethers.id("firmware.test.chip");
    const artifactDigest = ethers.sha256(ethers.toUtf8Bytes("artifact-v1"));
    const manifestDigest = ethers.sha256(ethers.toUtf8Bytes("manifest-v1"));

    await (await registry.connect(publisher).createChip(chipId, "ipfs://chip-metadata")).wait();
    await (
      await registry.connect(publisher).publishRevision(
        chipId,
        artifactDigest,
        manifestDigest,
        "1.0.0",
        "ipfs://artifact-v1"
      )
    ).wait();

    const revision = await registry.getRevision(chipId, 1);
    assert.equal(revision.artifactDigest, artifactDigest);
    assert.equal(revision.manifestDigest, manifestDigest);
    assert.equal(await registry.isRevisionActive(chipId, 1), true);

    await (await registry.connect(publisher).revokeRevision(chipId, 1)).wait();
    assert.equal(await registry.isRevisionActive(chipId, 1), false);
  });

  it("enforces installed selectors, call value and rolling budget before execution", async function () {
    const { owner, operator, publisher, registry, kernel, machine, target } = await deployCore();
    const chipId = ethers.id("firmware.execution.chip");
    const artifactDigest = ethers.sha256(ethers.toUtf8Bytes("artifact"));
    const manifestDigest = ethers.sha256(ethers.toUtf8Bytes("manifest"));

    await (await registry.connect(publisher).createChip(chipId, "")).wait();
    await (
      await registry.connect(publisher).publishRevision(
        chipId,
        artifactDigest,
        manifestDigest,
        "1.0.0",
        "ipfs://artifact"
      )
    ).wait();

    const setValueData = target.interface.encodeFunctionData("setValue", [42]);
    const targetAddress = await target.getAddress();
    const selector = setValueData.slice(0, 10);
    const latest = await ethers.provider.getBlock("latest");
    const expiresAt = BigInt(latest.timestamp + 3600);

    await (
      await machine.connect(owner).installChip(
        chipId,
        1,
        expiresAt,
        [{ target: targetAddress, selector, maxValue: ethers.parseEther("0.01"), spendMode: 1, budgetAsset: ethers.ZeroAddress, amountOffset: 0 }],
        [{
          asset: ethers.ZeroAddress,
          perCall: ethers.parseEther("0.01"),
          perWindow: ethers.parseEther("0.02"),
          windowSeconds: 3600
        }]
      )
    ).wait();

    await (await machine.connect(owner).setOperator(operator.address, true)).wait();
    await owner.sendTransaction({ to: await machine.getAddress(), value: ethers.parseEther("0.02") });

    await (
      await machine.connect(operator).executeChipCall(
        chipId,
        targetAddress,
        ethers.parseEther("0.005"),
        setValueData
      )
    ).wait();

    assert.equal(await target.value(), 42n);
    assert.equal(
      await kernel.remainingBudget(await machine.getAddress(), chipId, ethers.ZeroAddress),
      ethers.parseEther("0.015")
    );

    const forbiddenData = target.interface.encodeFunctionData("forbidden");
    await expectRevert(() =>
      machine.connect(operator).executeChipCall(
        chipId,
        targetAddress,
        0,
        forbiddenData
      )
    );

    await expectRevert(() =>
      machine.connect(operator).executeChipCall(
        chipId,
        targetAddress,
        ethers.parseEther("0.011"),
        setValueData
      )
    );
  });

  it("accepts receipts only from a Machine or its approved reporter", async function () {
    const [machine, reporter, stranger] = await ethers.getSigners();
    const ReceiptRegistry = await ethers.getContractFactory("ExecutionReceiptRegistry");
    const receipts = await ReceiptRegistry.deploy();
    await receipts.waitForDeployment();

    const invocationId = ethers.id("invocation-001");
    const args = [
      invocationId,
      machine.address,
      ethers.id("chip"),
      1,
      ethers.id("artifact"),
      ethers.id("input"),
      ethers.id("output"),
      ethers.ZeroAddress,
      80_000n,
      ethers.id("receipt-route"),
      0
    ];

    await expectRevert(() => receipts.connect(stranger).commit(...args));
    await (await receipts.connect(machine).setReporter(reporter.address, true)).wait();
    await (await receipts.connect(reporter).commit(...args)).wait();

    const receipt = await receipts.getReceipt(invocationId);
    assert.equal(receipt.machine, machine.address);
    assert.equal(receipt.reporter, reporter.address);
    await expectRevert(() => receipts.connect(reporter).commit(...args));
  });

  it("settles each receipt once and splits native or ERC20 payment without custody", async function () {
    const [payer, publisher, executor, protocol] = await ethers.getSigners();

    const ReceiptRegistry = await ethers.getContractFactory("ExecutionReceiptRegistry");
    const receipts = await ReceiptRegistry.deploy();
    await receipts.waitForDeployment();

    const Router = await ethers.getContractFactory("RevenueRouter");
    const router = await Router.deploy(await receipts.getAddress());
    await router.waitForDeployment();

    const Token = await ethers.getContractFactory("TestToken");
    const token = await Token.deploy();
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    const route = {
      publisher: publisher.address,
      executor: executor.address,
      protocol: protocol.address,
      publisherBps: 7000,
      executorBps: 2500,
      protocolBps: 500
    };

    const settlementRouteDigest = await router.routeDigest(route);

    const nativeInvocation = ethers.id("native-payment");
    await (
      await receipts.connect(payer).commit(
        nativeInvocation,
        payer.address,
        ethers.id("native-chip"),
        1,
        ethers.id("native-artifact"),
        ethers.id("native-input"),
        ethers.id("native-output"),
        ethers.ZeroAddress,
        ethers.parseEther("1"),
        settlementRouteDigest,
        0
      )
    ).wait();

    const wrongRoute = { ...route, publisher: payer.address };
    await expectRevert(() =>
      router.connect(payer).settleNative(nativeInvocation, wrongRoute, {
        value: ethers.parseEther("1")
      })
    );
    const publisherBefore = await ethers.provider.getBalance(publisher.address);
    await (
      await router.connect(payer).settleNative(nativeInvocation, route, {
        value: ethers.parseEther("1")
      })
    ).wait();
    assert.equal(
      (await ethers.provider.getBalance(publisher.address)) - publisherBefore,
      ethers.parseEther("0.7")
    );
    assert.equal(await ethers.provider.getBalance(await router.getAddress()), 0n);
    await expectRevert(() =>
      router.connect(payer).settleNative(nativeInvocation, route, {
        value: ethers.parseEther("1")
      })
    );

    const tokenInvocation = ethers.id("token-payment");
    await (
      await receipts.connect(payer).commit(
        tokenInvocation,
        payer.address,
        ethers.id("token-chip"),
        1,
        ethers.id("token-artifact"),
        ethers.id("token-input"),
        ethers.id("token-output"),
        tokenAddress,
        10_000n,
        settlementRouteDigest,
        0
      )
    ).wait();

    await (await token.mint(payer.address, 10_000n)).wait();
    await (await token.connect(payer).approve(await router.getAddress(), 10_000n)).wait();
    await expectRevert(() =>
      router.connect(payer).settleToken(
        tokenInvocation,
        tokenAddress,
        9_999n,
        route
      )
    );
    await (
      await router.connect(payer).settleToken(
        tokenInvocation,
        tokenAddress,
        10_000n,
        route
      )
    ).wait();

    assert.equal(await token.balanceOf(publisher.address), 7000n);
    assert.equal(await token.balanceOf(executor.address), 2500n);
    assert.equal(await token.balanceOf(protocol.address), 500n);
    assert.equal(await token.balanceOf(await router.getAddress()), 0n);
  });
  it("derives ERC20 spend from calldata and locks installation digests to the registry", async function () {
    const { owner, operator, publisher, registry, kernel, machine } = await deployCore();
    const [, , , , recipient] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("TestToken");
    const token = await Token.deploy();
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    const chipId = ethers.id("firmware.token-transfer.chip");
    const artifactDigest = ethers.sha256(ethers.toUtf8Bytes("token-artifact"));
    const manifestDigest = ethers.sha256(ethers.toUtf8Bytes("token-manifest"));
    await (await registry.connect(publisher).createChip(chipId, "")).wait();
    await (
      await registry.connect(publisher).publishRevision(
        chipId,
        artifactDigest,
        manifestDigest,
        "1.0.0",
        "ipfs://token-artifact"
      )
    ).wait();

    const transferData = token.interface.encodeFunctionData("transfer", [recipient.address, 60n]);
    const transferSelector = transferData.slice(0, 10);
    const latest = await ethers.provider.getBlock("latest");

    await (
      await machine.connect(owner).installChip(
        chipId,
        1,
        BigInt(latest.timestamp + 3600),
        [{
          target: tokenAddress,
          selector: transferSelector,
          maxValue: 0,
          spendMode: 2,
          budgetAsset: tokenAddress,
          amountOffset: 36
        }],
        [{
          asset: tokenAddress,
          perCall: 70,
          perWindow: 100,
          windowSeconds: 3600
        }]
      )
    ).wait();

    const installation = await kernel.getInstallation(await machine.getAddress(), chipId);
    assert.equal(installation.artifactDigest, artifactDigest);
    assert.equal(installation.manifestDigest, manifestDigest);

    await (await machine.connect(owner).setOperator(operator.address, true)).wait();
    await (await token.mint(await machine.getAddress(), 100n)).wait();
    await (
      await machine.connect(operator).executeChipCall(
        chipId,
        tokenAddress,
        0,
        transferData
      )
    ).wait();
    assert.equal(await token.balanceOf(recipient.address), 60n);
    assert.equal(
      await kernel.remainingBudget(await machine.getAddress(), chipId, tokenAddress),
      40n
    );

    const overWindow = token.interface.encodeFunctionData("transfer", [recipient.address, 50n]);
    await expectRevert(() =>
      machine.connect(operator).executeChipCall(chipId, tokenAddress, 0, overWindow)
    );
  });
  it("validates owner EIP 712 signatures through ERC 1271", async function () {
    const { owner, operator, machine } = await deployCore();
    const machineAddress = await machine.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const domain = {
      name: "firmware",
      version: "1",
      chainId,
      verifyingContract: machineAddress
    };
    const types = {
      Invocation: [
        { name: "invocationId", type: "bytes32" },
        { name: "machine", type: "address" },
        { name: "chipId", type: "bytes32" },
        { name: "artifactDigest", type: "bytes32" },
        { name: "inputDigest", type: "bytes32" },
        { name: "maximumCost", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "string" },
        { name: "routeDigest", type: "bytes32" }
      ]
    };
    const value = {
      invocationId: ethers.id("signed-invocation"),
      machine: machineAddress,
      chipId: ethers.id("signed-chip"),
      artifactDigest: ethers.id("signed-artifact"),
      inputDigest: ethers.id("signed-input"),
      maximumCost: 100n,
      deadline: 9_000n,
      nonce: "signed-nonce",
      routeDigest: ethers.id("signed-route")
    };

    const digest = ethers.TypedDataEncoder.hash(domain, types, value);
    const ownerSignature = await owner.signTypedData(domain, types, value);
    const operatorSignature = await operator.signTypedData(domain, types, value);

    assert.equal(
      await machine.isValidSignature(digest, ownerSignature),
      "0x1626ba7e"
    );
    assert.equal(
      await machine.isValidSignature(digest, operatorSignature),
      "0xffffffff"
    );
    assert.equal(await machine.isValidSignature(digest, "0x1234"), "0xffffffff");
  });
});