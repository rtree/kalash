// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1155MetadataURI} from "@openzeppelin/contracts/token/ERC1155/extensions/IERC1155MetadataURI.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

// OZ 5.7 ERC1155 imports Cancun-only MCOPY; this mint-only implementation targets Shanghai.
contract KalashStamp is IERC1155MetadataURI {
    address public immutable minter;
    mapping(bytes32 => bool) public consumed;

    struct Metadata {
        bytes32 templeId;
        uint8 kind;
        uint256 day;
    }
    mapping(uint256 => Metadata) private metadata;
    mapping(uint256 => address) private holders;

    error Unauthorized();
    error AlreadyConsumed();
    error Soulbound();
    error InvalidMinter();
    error InvalidKind();
    error UnknownStamp();
    error InvalidRecipient();
    error InvalidArrayLength();

    event StampMinted(
        bytes32 indexed donationId,
        address indexed recipient,
        uint256 indexed tokenId,
        bytes32 templeId,
        uint8 kind,
        uint256 day
    );

    constructor(address minter_) {
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
        if (recipient == address(0)) revert InvalidRecipient();
        consumed[donationId] = true;
        uint256 tokenId = uint256(donationId);
        metadata[tokenId] = Metadata(templeId, kind, day);
        holders[tokenId] = recipient;
        emit TransferSingle(msg.sender, address(0), recipient, tokenId, 1);
        if (recipient.code.length != 0) {
            if (
                IERC1155Receiver(recipient).onERC1155Received(
                    msg.sender, address(0), tokenId, 1, ""
                ) != IERC1155Receiver.onERC1155Received.selector
            ) revert InvalidRecipient();
        }
        emit StampMinted(donationId, recipient, tokenId, templeId, kind, day);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        if (!consumed[bytes32(tokenId)]) revert UnknownStamp();
        Metadata memory data = metadata[tokenId];
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(string.concat(
                '{"templeId":"', _hex(data.templeId),
                '","kind":', _decimal(data.kind),
                ',"date":', _decimal(data.day), "}"
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

    function balanceOf(address account, uint256 id) public view returns (uint256) {
        if (account == address(0)) revert InvalidRecipient();
        return holders[id] == account ? 1 : 0;
    }

    function balanceOfBatch(
        address[] calldata accounts, uint256[] calldata ids
    ) external view returns (uint256[] memory balances) {
        if (accounts.length != ids.length) revert InvalidArrayLength();
        balances = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) balances[i] = balanceOf(accounts[i], ids[i]);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId ||
            interfaceId == 0xd9b67a26 || interfaceId == type(IERC1155MetadataURI).interfaceId;
    }

    function _hex(bytes32 value) private pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory result = new bytes(66);
        result[0] = "0";
        result[1] = "x";
        for (uint256 i; i < 32; ++i) {
            result[2 + i * 2] = digits[uint8(value[i]) >> 4];
            result[3 + i * 2] = digits[uint8(value[i]) & 15];
        }
        return string(result);
    }

    function _decimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 remaining = value;
        uint256 length;
        while (remaining != 0) {
            ++length;
            remaining /= 10;
        }
        bytes memory result = new bytes(length);
        while (value != 0) {
            result[--length] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(result);
    }
}
