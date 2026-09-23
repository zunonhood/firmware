// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ChipRegistry
/// @notice Immutable revision history for executable capability packages.
contract ChipRegistry {
    struct Chip {
        address publisher;
        address pendingPublisher;
        uint64 latestRevision;
        bool exists;
        string metadataURI;
    }

    struct Revision {
        bytes32 artifactDigest;
        bytes32 manifestDigest;
        uint64 publishedAt;
        bool revoked;
        string version;
        string artifactURI;
    }

    mapping(bytes32 chipId => Chip) private _chips;
    mapping(bytes32 chipId => mapping(uint64 revision => Revision)) private _revisions;

    error ChipAlreadyExists();
    error ChipNotFound();
    error InvalidAddress();
    error InvalidDigest();
    error InvalidIdentifier();
    error InvalidRevision();
    error NotPublisher();
    error NotPendingPublisher();
    error RevisionAlreadyRevoked();

    event ChipCreated(bytes32 indexed chipId, address indexed publisher, string metadataURI);
    event RevisionPublished(
        bytes32 indexed chipId,
        uint64 indexed revision,
        bytes32 artifactDigest,
        bytes32 manifestDigest,
        string version,
        string artifactURI
    );
    event RevisionRevoked(bytes32 indexed chipId, uint64 indexed revision);
    event PublisherTransferStarted(bytes32 indexed chipId, address indexed currentPublisher, address indexed pendingPublisher);
    event PublisherTransferred(bytes32 indexed chipId, address indexed previousPublisher, address indexed newPublisher);
    event MetadataURIUpdated(bytes32 indexed chipId, string metadataURI);

    modifier onlyPublisher(bytes32 chipId) {
        Chip storage chip = _chips[chipId];
        if (!chip.exists) revert ChipNotFound();
        if (chip.publisher != msg.sender) revert NotPublisher();
        _;
    }

    function createChip(bytes32 chipId, string calldata metadataURI) external {
        if (chipId == bytes32(0)) revert InvalidIdentifier();
        if (_chips[chipId].exists) revert ChipAlreadyExists();

        _chips[chipId] = Chip({
            publisher: msg.sender,
            pendingPublisher: address(0),
            latestRevision: 0,
            exists: true,
            metadataURI: metadataURI
        });

        emit ChipCreated(chipId, msg.sender, metadataURI);
    }

    function publishRevision(
        bytes32 chipId,
        bytes32 artifactDigest,
        bytes32 manifestDigest,
        string calldata version,
        string calldata artifactURI
    ) external onlyPublisher(chipId) returns (uint64 revisionNumber) {
        if (artifactDigest == bytes32(0) || manifestDigest == bytes32(0)) revert InvalidDigest();
        if (bytes(version).length == 0 || bytes(artifactURI).length == 0) revert InvalidRevision();

        Chip storage chip = _chips[chipId];
        revisionNumber = ++chip.latestRevision;
        _revisions[chipId][revisionNumber] = Revision({
            artifactDigest: artifactDigest,
            manifestDigest: manifestDigest,
            publishedAt: uint64(block.timestamp),
            revoked: false,
            version: version,
            artifactURI: artifactURI
        });

        emit RevisionPublished(
            chipId,
            revisionNumber,
            artifactDigest,
            manifestDigest,
            version,
            artifactURI
        );
    }

    function revokeRevision(bytes32 chipId, uint64 revisionNumber) external onlyPublisher(chipId) {
        Revision storage revision = _revisions[chipId][revisionNumber];
        if (revision.publishedAt == 0) revert InvalidRevision();
        if (revision.revoked) revert RevisionAlreadyRevoked();
        revision.revoked = true;
        emit RevisionRevoked(chipId, revisionNumber);
    }

    function setMetadataURI(bytes32 chipId, string calldata metadataURI) external onlyPublisher(chipId) {
        _chips[chipId].metadataURI = metadataURI;
        emit MetadataURIUpdated(chipId, metadataURI);
    }

    function beginPublisherTransfer(bytes32 chipId, address nextPublisher) external onlyPublisher(chipId) {
        if (nextPublisher == address(0)) revert InvalidAddress();
        _chips[chipId].pendingPublisher = nextPublisher;
        emit PublisherTransferStarted(chipId, msg.sender, nextPublisher);
    }

    function acceptPublisher(bytes32 chipId) external {
        Chip storage chip = _chips[chipId];
        if (!chip.exists) revert ChipNotFound();
        if (chip.pendingPublisher != msg.sender) revert NotPendingPublisher();

        address previous = chip.publisher;
        chip.publisher = msg.sender;
        chip.pendingPublisher = address(0);
        emit PublisherTransferred(chipId, previous, msg.sender);
    }

    function getChip(bytes32 chipId) external view returns (Chip memory) {
        if (!_chips[chipId].exists) revert ChipNotFound();
        return _chips[chipId];
    }

    function getRevision(bytes32 chipId, uint64 revisionNumber) external view returns (Revision memory) {
        Revision memory revision = _revisions[chipId][revisionNumber];
        if (revision.publishedAt == 0) revert InvalidRevision();
        return revision;
    }

    function revisionDigests(bytes32 chipId, uint64 revisionNumber)
        external
        view
        returns (bytes32 artifactDigest, bytes32 manifestDigest, bool active)
    {
        Revision memory revision = _revisions[chipId][revisionNumber];
        return (
            revision.artifactDigest,
            revision.manifestDigest,
            revision.publishedAt != 0 && !revision.revoked
        );
    }
    function isRevisionActive(bytes32 chipId, uint64 revisionNumber) external view returns (bool) {
        Revision memory revision = _revisions[chipId][revisionNumber];
        return revision.publishedAt != 0 && !revision.revoked;
    }
}
