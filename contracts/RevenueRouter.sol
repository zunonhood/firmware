// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";

interface IExecutionReceiptRegistry {
    function getSettlement(bytes32 invocationId) external view returns (address asset, uint256 amount, bytes32 routeDigest);
}

/// @title RevenueRouter
/// @notice Noncustodial native and ERC20 settlement for completed executions.
contract RevenueRouter {
    uint256 public constant BPS_SCALE = 10_000;

    struct Route {
        address publisher;
        address executor;
        address protocol;
        uint16 publisherBps;
        uint16 executorBps;
        uint16 protocolBps;
    }

    IExecutionReceiptRegistry public immutable receipts;
    mapping(bytes32 invocationId => bool) public settled;

    bool private _locked;

    error AlreadySettled();
    error InvalidAmount();
    error InvalidReceipt();
    error InvalidReceiptRegistry();
    error InvalidRoute();
    error Reentrancy();
    error TransferFailed();

    event RevenueSettled(
        bytes32 indexed invocationId,
        address indexed payer,
        address indexed asset,
        uint256 amount,
        address publisher,
        uint256 publisherAmount,
        address executor,
        uint256 executorAmount,
        address protocol,
        uint256 protocolAmount
    );

    constructor(address receiptRegistry) {
        if (receiptRegistry == address(0)) revert InvalidReceiptRegistry();
        receipts = IExecutionReceiptRegistry(receiptRegistry);
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    function settleNative(bytes32 invocationId, Route calldata route) external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        _claimReceipt(invocationId, address(0), msg.value, routeDigest(route));
        _validate(route);
        (uint256 publisherAmount, uint256 executorAmount, uint256 protocolAmount) =
            _split(msg.value, route);

        _sendNative(route.publisher, publisherAmount);
        _sendNative(route.executor, executorAmount);
        _sendNative(route.protocol, protocolAmount);

        emit RevenueSettled(
            invocationId,
            msg.sender,
            address(0),
            msg.value,
            route.publisher,
            publisherAmount,
            route.executor,
            executorAmount,
            route.protocol,
            protocolAmount
        );
    }

    function settleToken(
        bytes32 invocationId,
        address asset,
        uint256 amount,
        Route calldata route
    ) external nonReentrant {
        if (asset == address(0) || amount == 0) revert InvalidAmount();
        _claimReceipt(invocationId, asset, amount, routeDigest(route));
        _validate(route);
        (uint256 publisherAmount, uint256 executorAmount, uint256 protocolAmount) =
            _split(amount, route);

        _safeTransferFrom(asset, msg.sender, route.publisher, publisherAmount);
        _safeTransferFrom(asset, msg.sender, route.executor, executorAmount);
        _safeTransferFrom(asset, msg.sender, route.protocol, protocolAmount);

        emit RevenueSettled(
            invocationId,
            msg.sender,
            asset,
            amount,
            route.publisher,
            publisherAmount,
            route.executor,
            executorAmount,
            route.protocol,
            protocolAmount
        );
    }

    function routeDigest(Route calldata route) public pure returns (bytes32) {
        return keccak256(abi.encode(
            route.publisher,
            route.executor,
            route.protocol,
            route.publisherBps,
            route.executorBps,
            route.protocolBps
        ));
    }

    function preview(uint256 amount, Route calldata route)
        external
        pure
        returns (uint256 publisherAmount, uint256 executorAmount, uint256 protocolAmount)
    {
        _validate(route);
        return _split(amount, route);
    }

    function _claimReceipt(bytes32 invocationId, address asset, uint256 amount, bytes32 routeDigestForClaim) private {
        if (settled[invocationId]) revert AlreadySettled();
        (address receiptAsset, uint256 receiptAmount, bytes32 receiptRouteDigest) =
            receipts.getSettlement(invocationId);
        if (
            receiptAsset != asset ||
            receiptAmount != amount ||
            receiptRouteDigest != routeDigestForClaim
        ) revert InvalidReceipt();
        settled[invocationId] = true;
    }

    function _validate(Route calldata route) private pure {
        if (
            uint256(route.publisherBps) + route.executorBps + route.protocolBps != BPS_SCALE
        ) revert InvalidRoute();

        if (
            (route.publisherBps != 0 && route.publisher == address(0)) ||
            (route.executorBps != 0 && route.executor == address(0)) ||
            (route.protocolBps != 0 && route.protocol == address(0))
        ) revert InvalidRoute();
    }

    function _split(uint256 amount, Route calldata route)
        private
        pure
        returns (uint256 publisherAmount, uint256 executorAmount, uint256 protocolAmount)
    {
        executorAmount = amount * route.executorBps / BPS_SCALE;
        protocolAmount = amount * route.protocolBps / BPS_SCALE;
        publisherAmount = amount - executorAmount - protocolAmount;
    }

    function _sendNative(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}