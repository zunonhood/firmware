// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ExecutionReceiptRegistry
/// @notice Machine authorized attestations for offchain or onchain Chip executions.
contract ExecutionReceiptRegistry {
    enum Status { Completed, Failed, Rejected }

    struct Receipt {
        address machine;
        address reporter;
        bytes32 chipId;
        uint64 revision;
        bytes32 artifactDigest;
        bytes32 inputDigest;
        bytes32 outputDigest;
        address costAsset;
        uint128 cost;
        bytes32 routeDigest;
        uint64 completedAt;
        Status status;
    }

    mapping(address machine => mapping(address reporter => bool)) public reporters;
    mapping(bytes32 invocationId => Receipt) private _receipts;

    error InvalidIdentifier();
    error NotAuthorizedReporter();
    error ReceiptAlreadyExists();
    error ReceiptNotFound();

    event ReporterSet(address indexed machine, address indexed reporter, bool allowed);
    event ReceiptCommitted(
        bytes32 indexed invocationId,
        address indexed machine,
        bytes32 indexed chipId,
        uint64 revision,
        address reporter,
        Status status,
        address costAsset,
        uint256 cost,
        bytes32 routeDigest,
        bytes32 outputDigest
    );

    function setReporter(address reporter, bool allowed) external {
        reporters[msg.sender][reporter] = allowed;
        emit ReporterSet(msg.sender, reporter, allowed);
    }

    function commit(
        bytes32 invocationId,
        address machine,
        bytes32 chipId,
        uint64 revision,
        bytes32 artifactDigest,
        bytes32 inputDigest,
        bytes32 outputDigest,
        address costAsset,
        uint128 cost,
        bytes32 routeDigest,
        Status status
    ) external {
        if (
            invocationId == bytes32(0) ||
            chipId == bytes32(0) ||
            artifactDigest == bytes32(0) ||
            routeDigest == bytes32(0)
        ) revert InvalidIdentifier();
        if (msg.sender != machine && !reporters[machine][msg.sender]) revert NotAuthorizedReporter();
        if (_receipts[invocationId].completedAt != 0) revert ReceiptAlreadyExists();

        _receipts[invocationId] = Receipt({
            machine: machine,
            reporter: msg.sender,
            chipId: chipId,
            revision: revision,
            artifactDigest: artifactDigest,
            inputDigest: inputDigest,
            outputDigest: outputDigest,
            costAsset: costAsset,
            cost: cost,
            routeDigest: routeDigest,
            completedAt: uint64(block.timestamp),
            status: status
        });

        emit ReceiptCommitted(
            invocationId,
            machine,
            chipId,
            revision,
            msg.sender,
            status,
            costAsset,
            cost,
            routeDigest,
            outputDigest
        );
    }

    function getReceipt(bytes32 invocationId) external view returns (Receipt memory) {
        Receipt memory receipt = _receipts[invocationId];
        if (receipt.completedAt == 0) revert ReceiptNotFound();
        return receipt;
    }

    function exists(bytes32 invocationId) external view returns (bool) {
        return _receipts[invocationId].completedAt != 0;
    }

    function getSettlement(bytes32 invocationId)
        external
        view
        returns (address asset, uint256 amount, bytes32 routeDigest)
    {
        Receipt memory receipt = _receipts[invocationId];
        if (receipt.completedAt == 0) revert ReceiptNotFound();
        return (receipt.costAsset, receipt.cost, receipt.routeDigest);
    }
}