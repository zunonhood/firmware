// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

struct PermissionKernelCallRule {
    address target;
    bytes4 selector;
    uint128 maxValue;
    uint8 spendMode;
    address budgetAsset;
    uint16 amountOffset;
}

struct PermissionKernelBudget {
    address asset;
    uint128 perCall;
    uint128 perWindow;
    uint48 windowSeconds;
}

interface IPermissionKernel {
    function install(
        bytes32 chipId,
        uint64 revision,
        uint64 expiresAt,
        PermissionKernelCallRule[] calldata rules,
        PermissionKernelBudget[] calldata budgets
    ) external;

    function revoke(bytes32 chipId) external;

    function consumeAndAuthorize(
        address machine,
        bytes32 chipId,
        address target,
        uint256 value,
        bytes calldata callData
    ) external;
}

/// @title MachineAccount
/// @notice Owner controlled account whose operators can execute only installed Chip authority.
contract MachineAccount {
    bytes4 public constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 public constant ERC1271_INVALID = 0xffffffff;
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IPermissionKernel public immutable kernel;
    address public owner;
    address public pendingOwner;
    mapping(address operator => bool) public operators;

    error CallFailed(bytes returnData);
    error InvalidAddress();
    error NotOperator();
    error NotOwner();
    error NotPendingOwner();

    event OperatorSet(address indexed operator, bool allowed);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ChipCallExecuted(
        bytes32 indexed chipId,
        address indexed operator,
        address indexed target,
        uint256 value,
        bytes32 resultDigest
    );

    constructor(address initialOwner, address kernelAddress) {
        if (initialOwner == address(0) || kernelAddress == address(0)) revert InvalidAddress();
        owner = initialOwner;
        kernel = IPermissionKernel(kernelAddress);
    }

    receive() external payable {}

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function installChip(
        bytes32 chipId,
        uint64 revision,
        uint64 expiresAt,
        PermissionKernelCallRule[] calldata rules,
        PermissionKernelBudget[] calldata budgets
    ) external onlyOwner {
        kernel.install(chipId, revision, expiresAt, rules, budgets);
    }

    function revokeChip(bytes32 chipId) external onlyOwner {
        kernel.revoke(chipId);
    }

    function executeChipCall(
        bytes32 chipId,
        address target,
        uint256 value,
        bytes calldata callData
    ) external returns (bytes memory result) {
        if (msg.sender != owner && !operators[msg.sender]) revert NotOperator();

        kernel.consumeAndAuthorize(address(this), chipId, target, value, callData);

        (bool ok, bytes memory returnData) = target.call{value: value}(callData);
        if (!ok) revert CallFailed(returnData);

        emit ChipCallExecuted(chipId, msg.sender, target, value, keccak256(returnData));
        return returnData;
    }

    /// @notice ERC 1271 validation lets the owner authorize offchain firmware invocations.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return ERC1271_INVALID;

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (uint256(s) > SECP256K1_HALF_ORDER || (v != 27 && v != 28)) {
            return ERC1271_INVALID;
        }

        address signer = ecrecover(digest, v, r, s);
        return signer == owner ? ERC1271_MAGIC_VALUE : ERC1271_INVALID;
    }
    function beginOwnershipTransfer(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidAddress();
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(owner, nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }
}