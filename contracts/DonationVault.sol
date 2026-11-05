// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract DonationVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable authorizer;
    address public immutable feeRecipient;
    mapping(bytes32 => address) public recipients;
    mapping(bytes32 => bool) public consumed;

    bytes32 private constant DONATION_TYPEHASH = keccak256(
        "Donation(bytes32 donationId,address donor,bytes32 templeId,uint8 kind,uint256 amount,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidKind();
    error Expired();
    error UnknownTemple();
    error AlreadyConsumed();
    error Unauthorized();

    event Donated(
        bytes32 indexed donationId,
        address indexed donor,
        bytes32 indexed templeId,
        uint8 kind,
        uint256 amount,
        uint256 fee,
        address recipient
    );

    constructor(
        address token_,
        address authorizer_,
        address feeRecipient_,
        bytes32[] memory templeIds,
        address[] memory recipients_
    ) {
        if (
            token_ == address(0) || token_.code.length == 0 ||
            authorizer_ == address(0) || feeRecipient_ == address(0) ||
            templeIds.length == 0 || templeIds.length != recipients_.length
        ) revert InvalidConfiguration();
        token = IERC20(token_);
        authorizer = authorizer_;
        feeRecipient = feeRecipient_;
        for (uint256 i; i < templeIds.length; ++i) {
            if (
                recipients_[i] == address(0) ||
                recipients[templeIds[i]] != address(0)
            ) revert InvalidConfiguration();
            recipients[templeIds[i]] = recipients_[i];
        }
    }

    function donate(
        bytes32 donationId,
        bytes32 templeId,
        uint8 kind,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (amount == 0 || amount > 1_000_000) revert InvalidAmount();
        if (kind > 1) revert InvalidKind();
        if (block.timestamp > deadline) revert Expired();
        address recipient = recipients[templeId];
        if (recipient == address(0)) revert UnknownTemple();
        if (consumed[donationId]) revert AlreadyConsumed();
        bytes32 domainSeparator = keccak256(abi.encode(
            DOMAIN_TYPEHASH, keccak256("KALASH Donation"), keccak256("1"), block.chainid, address(this)
        ));
        bytes32 structHash = keccak256(abi.encode(
            DONATION_TYPEHASH, donationId, msg.sender, templeId, kind, amount, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
        if (ECDSA.recover(digest, signature) != authorizer) revert Unauthorized();

        consumed[donationId] = true;
        uint256 fee = amount / 10_000;
        if (fee != 0) token.safeTransferFrom(msg.sender, feeRecipient, fee);
        token.safeTransferFrom(msg.sender, recipient, amount - fee);
        emit Donated(donationId, msg.sender, templeId, kind, amount, fee, recipient);
    }
}
