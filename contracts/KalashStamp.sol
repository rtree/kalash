// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract KalashStamp is ERC1155 {
    address public immutable minter;
    mapping(bytes32 => bool) public consumed;

    struct Metadata {
        bytes32 templeId;
        uint8 kind;
        uint256 day;
    }
    mapping(uint256 => Metadata) private metadata;

    error Unauthorized();
    error AlreadyConsumed();
    error Soulbound();
    error InvalidMinter();
    error InvalidKind();
    error UnknownStamp();

    event StampMinted(
        bytes32 indexed donationId,
        address indexed recipient,
        uint256 indexed tokenId,
        bytes32 templeId,
        uint8 kind,
        uint256 day
    );

    constructor(address minter_) ERC1155("") {
        if (minter_ == address(0)) revert InvalidMinter();
        minter = minter_;
    }

    function mint(
        bytes32 donationId,
        address recipient,
        bytes32 templeId,
        uint8 kind,
        uint256 day
    ) external {
        if (msg.sender != minter) revert Unauthorized();
        if (consumed[donationId]) revert AlreadyConsumed();
        if (kind > 1) revert InvalidKind();
        consumed[donationId] = true;
        uint256 tokenId = uint256(donationId);
        metadata[tokenId] = Metadata(templeId, kind, day);
        _mint(recipient, tokenId, 1, "");
        emit StampMinted(donationId, recipient, tokenId, templeId, kind, day);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        if (!consumed[bytes32(tokenId)]) revert UnknownStamp();
        Metadata memory data = metadata[tokenId];
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(string.concat(
                '{"templeId":"', Strings.toHexString(uint256(data.templeId), 32),
                '","kind":', Strings.toString(data.kind),
                ',"date":', Strings.toString(data.day), "}"
            )))
        );
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, uint256, bytes memory) public pure override {
        revert Soulbound();
    }

    function safeBatchTransferFrom(
        address, address, uint256[] memory, uint256[] memory, bytes memory
    ) public pure override {
        revert Soulbound();
    }

    function _update(
        address from, address to, uint256[] memory ids, uint256[] memory values
    ) internal override {
        if (from != address(0)) revert Soulbound();
        super._update(from, to, ids, values);
    }
}
