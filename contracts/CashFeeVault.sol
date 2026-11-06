// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract CashFeeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable authorizer;
    address public immutable feeRecipient;
    mapping(bytes32 => bool) public consumed;
    bytes32 private constant FEE_TYPEHASH = keccak256(
        "CashFee(bytes32 invoiceId,address payer,bytes32 templeId,uint256 amount,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    error InvalidConfiguration();
    error InvalidAmount();
    error Expired();
    error AlreadyConsumed();
    error Unauthorized();

    event FeePaid(
        bytes32 indexed invoiceId,
        address indexed payer,
        bytes32 indexed templeId,
        uint256 amount,
        address recipient
    );

    constructor(address token_, address authorizer_, address feeRecipient_) {
        if (token_ == address(0) || token_.code.length == 0 ||
            authorizer_ == address(0) || feeRecipient_ == address(0)) revert InvalidConfiguration();
        token = IERC20(token_);
        authorizer = authorizer_;
        feeRecipient = feeRecipient_;
    }

    function payFee(
        bytes32 invoiceId, bytes32 templeId, uint256 amount, uint256 deadline, bytes calldata signature
    ) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (block.timestamp > deadline) revert Expired();
        if (consumed[invoiceId]) revert AlreadyConsumed();
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH, keccak256("KALASH Cash Fee"), keccak256("1"), block.chainid, address(this)
        ));
        bytes32 message = keccak256(abi.encode(
            FEE_TYPEHASH, invoiceId, msg.sender, templeId, amount, deadline
        ));
        if (ECDSA.recover(keccak256(abi.encodePacked(hex"1901", domain, message)), signature) != authorizer)
            revert Unauthorized();
        consumed[invoiceId] = true;
        token.safeTransferFrom(msg.sender, feeRecipient, amount);
        emit FeePaid(invoiceId, msg.sender, templeId, amount, feeRecipient);
    }
}
