// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IChipRegistry {
    function revisionDigests(bytes32 chipId, uint64 revision)
        external
        view
        returns (bytes32 artifactDigest, bytes32 manifestDigest, bool active);
}

/// @title PermissionKernel
/// @notice Stores Machine approved Chip policies and derives spend from the authorized call itself.
contract PermissionKernel {
    uint8 public constant SPEND_NONE = 0;
    uint8 public constant SPEND_NATIVE_VALUE = 1;
    uint8 public constant SPEND_CALLDATA_UINT256 = 2;

    struct Installation {
        uint64 revision;
        uint64 generation;
        uint64 expiresAt;
        bytes32 artifactDigest;
        bytes32 manifestDigest;
        bool active;
    }

    struct CallRuleInput {
        address target;
        bytes4 selector;
        uint128 maxValue;
        uint8 spendMode;
        address budgetAsset;
        uint16 amountOffset;
    }

    struct CallRule {
        uint128 maxValue;
        uint64 generation;
        uint16 amountOffset;
        uint8 spendMode;
        address budgetAsset;
        bool enabled;
    }

    struct BudgetInput {
        address asset;
        uint128 perCall;
        uint128 perWindow;
        uint48 windowSeconds;
    }

    struct Budget {
        uint128 perCall;
        uint128 perWindow;
        uint128 spent;
        uint64 windowStartedAt;
        uint48 windowSeconds;
        uint64 generation;
        bool enabled;
    }

    IChipRegistry public immutable registry;

    mapping(address machine => mapping(address operator => bool)) public operators;
    mapping(address machine => mapping(bytes32 chipId => Installation)) private _installations;
    mapping(address machine => mapping(bytes32 chipId => mapping(bytes32 ruleKey => CallRule))) private _callRules;
    mapping(address machine => mapping(bytes32 chipId => mapping(address asset => Budget))) private _budgets;

    error AuthorizationDenied();
    error BudgetExceeded();
    error ChipNotInstalled();
    error EmptyRules();
    error InstallationExpired();
    error InvalidExpiry();
    error InvalidRegistry();
    error InvalidSpendRule();
    error InvalidWindow();
    error RevisionUnavailable();

    event OperatorSet(address indexed machine, address indexed operator, bool allowed);
    event ChipInstalled(
        address indexed machine,
        bytes32 indexed chipId,
        uint64 indexed revision,
        bytes32 artifactDigest,
        bytes32 manifestDigest,
        uint64 expiresAt,
        uint64 generation
    );
    event ChipRevoked(address indexed machine, bytes32 indexed chipId);
    event BudgetConsumed(
        address indexed machine,
        bytes32 indexed chipId,
        address indexed asset,
        uint256 amount,
        uint256 spentInWindow
    );

    constructor(address registryAddress) {
        if (registryAddress == address(0)) revert InvalidRegistry();
        registry = IChipRegistry(registryAddress);
    }

    modifier onlyMachineOrOperator(address machine) {
        if (msg.sender != machine && !operators[machine][msg.sender]) revert AuthorizationDenied();
        _;
    }

    function setOperator(address operator, bool allowed) external {
        operators[msg.sender][operator] = allowed;
        emit OperatorSet(msg.sender, operator, allowed);
    }

    function install(
        bytes32 chipId,
        uint64 revision,
        uint64 expiresAt,
        CallRuleInput[] calldata rules,
        BudgetInput[] calldata budgets
    ) external {
        (bytes32 artifactDigest, bytes32 manifestDigest, bool revisionActive) =
            registry.revisionDigests(chipId, revision);
        if (!revisionActive || artifactDigest == bytes32(0) || manifestDigest == bytes32(0)) {
            revert RevisionUnavailable();
        }
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
        if (rules.length == 0) revert EmptyRules();

        Installation storage current = _installations[msg.sender][chipId];
        uint64 generation = current.generation + 1;
        _installations[msg.sender][chipId] = Installation({
            revision: revision,
            generation: generation,
            expiresAt: expiresAt,
            artifactDigest: artifactDigest,
            manifestDigest: manifestDigest,
            active: true
        });

        for (uint256 i; i < rules.length; ++i) {
            CallRuleInput calldata rule = rules[i];
            _validateRule(rule);
            _callRules[msg.sender][chipId][_ruleKey(rule.target, rule.selector)] = CallRule({
                maxValue: rule.maxValue,
                generation: generation,
                amountOffset: rule.amountOffset,
                spendMode: rule.spendMode,
                budgetAsset: rule.budgetAsset,
                enabled: true
            });
        }

        for (uint256 i; i < budgets.length; ++i) {
            BudgetInput calldata input = budgets[i];
            if (input.windowSeconds == 0 || input.perCall > input.perWindow) revert InvalidWindow();
            _budgets[msg.sender][chipId][input.asset] = Budget({
                perCall: input.perCall,
                perWindow: input.perWindow,
                spent: 0,
                windowStartedAt: uint64(block.timestamp),
                windowSeconds: input.windowSeconds,
                generation: generation,
                enabled: true
            });
        }

        emit ChipInstalled(
            msg.sender,
            chipId,
            revision,
            artifactDigest,
            manifestDigest,
            expiresAt,
            generation
        );
    }

    function revoke(bytes32 chipId) external {
        Installation storage installation = _installations[msg.sender][chipId];
        if (!installation.active) revert ChipNotInstalled();
        installation.active = false;
        emit ChipRevoked(msg.sender, chipId);
    }

    function authorize(
        address machine,
        bytes32 chipId,
        address target,
        uint256 value,
        bytes calldata callData
    ) public view returns (bool) {
        Installation memory installation = _activeInstallation(machine, chipId);
        if (callData.length < 4) return false;
        CallRule memory rule = _callRules[machine][chipId][_ruleKey(target, bytes4(callData[:4]))];
        return rule.enabled && rule.generation == installation.generation && value <= rule.maxValue;
    }

    function consumeAndAuthorize(
        address machine,
        bytes32 chipId,
        address target,
        uint256 value,
        bytes calldata callData
    ) external onlyMachineOrOperator(machine) {
        Installation memory installation = _activeInstallation(machine, chipId);
        if (callData.length < 4) revert AuthorizationDenied();

        CallRule memory rule = _callRules[machine][chipId][_ruleKey(target, bytes4(callData[:4]))];
        if (!rule.enabled || rule.generation != installation.generation || value > rule.maxValue) {
            revert AuthorizationDenied();
        }

        (address asset, uint256 amount) = _deriveSpend(rule, value, callData);
        if (amount != 0) _consumeBudget(machine, chipId, asset, amount, installation.generation);
    }

    function remainingBudget(address machine, bytes32 chipId, address asset)
        external
        view
        returns (uint256)
    {
        Installation memory installation = _activeInstallation(machine, chipId);
        Budget memory budget = _budgets[machine][chipId][asset];
        if (!budget.enabled || budget.generation != installation.generation) return 0;
        if (block.timestamp >= uint256(budget.windowStartedAt) + budget.windowSeconds) {
            return budget.perWindow;
        }
        return budget.perWindow - budget.spent;
    }

    function getInstallation(address machine, bytes32 chipId) external view returns (Installation memory) {
        return _installations[machine][chipId];
    }

    function getCallRule(address machine, bytes32 chipId, address target, bytes4 selector)
        external
        view
        returns (CallRule memory)
    {
        return _callRules[machine][chipId][_ruleKey(target, selector)];
    }

    function getBudget(address machine, bytes32 chipId, address asset)
        external
        view
        returns (Budget memory)
    {
        return _budgets[machine][chipId][asset];
    }

    function _deriveSpend(CallRule memory rule, uint256 value, bytes calldata callData)
        private
        pure
        returns (address asset, uint256 amount)
    {
        if (rule.spendMode == SPEND_NONE) {
            if (value != 0) revert InvalidSpendRule();
            return (address(0), 0);
        }
        if (rule.spendMode == SPEND_NATIVE_VALUE) {
            return (address(0), value);
        }
        if (rule.spendMode == SPEND_CALLDATA_UINT256) {
            if (value != 0 || callData.length < uint256(rule.amountOffset) + 32) {
                revert InvalidSpendRule();
            }
            assembly {
                amount := calldataload(add(callData.offset, mload(add(rule, 0x40))))
            }
            return (rule.budgetAsset, amount);
        }
        revert InvalidSpendRule();
    }

    function _consumeBudget(
        address machine,
        bytes32 chipId,
        address asset,
        uint256 amount,
        uint64 generation
    ) private {
        Budget storage budget = _budgets[machine][chipId][asset];
        if (!budget.enabled || budget.generation != generation || amount > budget.perCall) {
            revert BudgetExceeded();
        }

        if (block.timestamp >= uint256(budget.windowStartedAt) + budget.windowSeconds) {
            budget.windowStartedAt = uint64(block.timestamp);
            budget.spent = 0;
        }

        uint256 nextSpent = uint256(budget.spent) + amount;
        if (nextSpent > budget.perWindow) revert BudgetExceeded();
        budget.spent = uint128(nextSpent);
        emit BudgetConsumed(machine, chipId, asset, amount, nextSpent);
    }

    function _activeInstallation(address machine, bytes32 chipId)
        private
        view
        returns (Installation memory installation)
    {
        installation = _installations[machine][chipId];
        if (!installation.active) revert ChipNotInstalled();
        if (block.timestamp >= installation.expiresAt) revert InstallationExpired();
        (, , bool revisionActive) = registry.revisionDigests(chipId, installation.revision);
        if (!revisionActive) revert RevisionUnavailable();
    }

    function _validateRule(CallRuleInput calldata rule) private pure {
        if (rule.target == address(0) || rule.selector == bytes4(0)) revert InvalidSpendRule();
        if (rule.spendMode == SPEND_NONE) {
            if (rule.budgetAsset != address(0) || rule.amountOffset != 0 || rule.maxValue != 0) {
                revert InvalidSpendRule();
            }
        } else if (rule.spendMode == SPEND_NATIVE_VALUE) {
            if (rule.budgetAsset != address(0) || rule.amountOffset != 0) revert InvalidSpendRule();
        } else if (rule.spendMode == SPEND_CALLDATA_UINT256) {
            if (rule.budgetAsset == address(0) || rule.amountOffset < 4 || rule.maxValue != 0) {
                revert InvalidSpendRule();
            }
        } else {
            revert InvalidSpendRule();
        }
    }

    function _ruleKey(address target, bytes4 selector) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(target, selector));
    }
}