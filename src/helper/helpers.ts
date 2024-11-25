// Helpers for the general mapping.ts file
import {
  Address,
  BigDecimal,
  BigInt,
  ByteArray,
  crypto,
  ethereum,
  log,
} from "@graphprotocol/graph-ts";
import { ProtocolData } from "./manager";
import {
  Market,
  Token,
  _FlashLoanPremium,
  Protocol as LendingProtocol
} from "../../generated/schema";
import {
  BIGINT_ZERO,
  BIGINT_ONE,
  BIGDECIMAL_ZERO,
  IzarbanTokenType,
  INT_TWO,
  BIGINT_THREE,
  ZERO_ADDRESS,
} from "./constants";
import { ZToken } from "../../generated/LendingPool/ZToken";
import { StableDebtToken } from "../../generated/LendingPool/StableDebtToken";
import { VariableDebtToken } from "../../generated/LendingPool/VariableDebtToken";
import {
  INT_FIVE,
  INT_NINE,
  INT_TEN,
  INT_THREE,
  InterestRateType,
  PositionSide,
} from "./constants";

// returns the market based on any auxillary token
// ie, outputToken, vToken, or sToken
export function getMarketByAuxillaryToken(
  auxillaryToken: Address,
  protocolData: ProtocolData
): Market | null {

  const protocol = LendingProtocol.load(protocolData.protocolID);
  let markets: Market[];
  if (protocol === null) {
    log.warning("[_handleUnpaused] LendingProtocol does not exist", []);
    return null;
  } else {
    markets = protocol.markets.load();
  }

  if (!markets) {
    log.warning("[getMarketByAuxillaryToken]marketList not found for id {}", [
      protocolData.protocolID.toHexString(),
    ]);
    return null;
  }
  for (let i = 0; i < markets.length; i++) {
    const market = Market.load(markets[i].id);

    if (!market) {
      continue;
    }

    if (market.outputToken && market.outputToken!.equals(auxillaryToken)) {
      // we found a matching market!
      return market;
    }
    if (market._vToken && market._vToken!.equals(auxillaryToken)) {
      return market;
    }
    if (market._sToken && market._sToken!.equals(auxillaryToken)) {
      return market;
    }
  }

  return null; // no market found
}

// this is more efficient than getMarketByAuxillaryToken()
// but requires a token._market field
export function getMarketFromToken(
  tokenAddress: Address,
  protocolData: ProtocolData
): Market | null {
  const token = Token.load(tokenAddress);
  if (!token) {
    log.error("[getMarketFromToken] token {} not exist", [
      tokenAddress.toHexString(),
    ]);
    return null;
  }
  if (!token._market) {
    log.warning("[getMarketFromToken] token {} _market = null", [
      tokenAddress.toHexString(),
    ]);
    return getMarketByAuxillaryToken(tokenAddress, protocolData);
  }

  const marketId = Address.fromBytes(token._market!);
  const market = Market.load(marketId);
  return market;
}
export function getBorrowBalances(market: Market, account: Address): BigInt[] {
  let sDebtTokenBalance = BIGINT_ZERO;
  let vDebtTokenBalance = BIGINT_ZERO;

  // get account's balance of variable debt
  if (market._vToken) {
    const vTokenContract = ZToken.bind(Address.fromBytes(market._vToken!));
    const tryVDebtTokenBalance = vTokenContract.try_balanceOf(account);
    vDebtTokenBalance = tryVDebtTokenBalance.reverted
      ? BIGINT_ZERO
      : tryVDebtTokenBalance.value;
  }

  // get account's balance of stable debt
  if (market._sToken) {
    const sTokenContract = ZToken.bind(Address.fromBytes(market._sToken!));
    const trySDebtTokenBalance = sTokenContract.try_balanceOf(account);
    sDebtTokenBalance = trySDebtTokenBalance.reverted
      ? BIGINT_ZERO
      : trySDebtTokenBalance.value;
  }

  return [sDebtTokenBalance, vDebtTokenBalance];
}

export function getCollateralBalance(market: Market, account: Address): BigInt {
  const collateralBalance = BIGINT_ZERO;
  const ZTokenContract = ZToken.bind(Address.fromBytes(market.outputToken!));
  const balanceResult = ZTokenContract.try_balanceOf(account);
  if (balanceResult.reverted) {
    log.warning(
      "[getCollateralBalance]failed to get ZToken {} balance for {}",
      [market.outputToken!.toHexString(), account.toHexString()]
    );
    return collateralBalance;
  }

  return balanceResult.value;
}

export function getPrincipal(
  market: Market,
  account: Address,
  side: string,
  interestRateType: InterestRateType | null = null
): BigInt | null {
  if (side == PositionSide.COLLATERAL) {
    const ZTokenContract = ZToken.bind(Address.fromBytes(market.outputToken!));
    const scaledBalanceResult = ZTokenContract.try_scaledBalanceOf(account);
    if (scaledBalanceResult.reverted) {
      log.warning(
        "[getPrincipal]failed to get ZToken {} scaledBalance for {}",
        [market.outputToken!.toHexString(), account.toHexString()]
      );
      return null;
    }
    return scaledBalanceResult.value;
  } else if (side == PositionSide.BORROWER && interestRateType) {
    if (interestRateType == InterestRateType.STABLE) {
      const stableDebtTokenContract = StableDebtToken.bind(
        Address.fromBytes(market._sToken!)
      );
      const principalBalanceResult =
        stableDebtTokenContract.try_principalBalanceOf(account);
      if (principalBalanceResult.reverted) {
        log.warning(
          "[getPrincipal]failed to get stableDebtToken {} principalBalance for {}",
          [market._sToken!.toHexString(), account.toHexString()]
        );
        return null;
      }
      return principalBalanceResult.value;
    } else if (interestRateType == InterestRateType.VARIABLE) {
      const variableDebtTokenContract = VariableDebtToken.bind(
        Address.fromBytes(market._vToken!)
      );
      const scaledBalanceResult =
        variableDebtTokenContract.try_scaledBalanceOf(account);
      if (scaledBalanceResult.reverted) {
        log.warning(
          "[getPrincipal]failed to get variableDebtToken {} scaledBalance for {}",
          [market._vToken!.toHexString(), account.toHexString()]
        );
        return null;
      }
      return scaledBalanceResult.value;
    }
  }

  return null;
}


export function getOrCreateFlashloanPremium(
  procotolData: ProtocolData
): _FlashLoanPremium {
  let flashloanPremium = _FlashLoanPremium.load(procotolData.protocolID);
  if (!flashloanPremium) {
    flashloanPremium = new _FlashLoanPremium(procotolData.protocolID);
    flashloanPremium.premiumRateTotal = BIGDECIMAL_ZERO;
    flashloanPremium.premiumRateToProtocol = BIGDECIMAL_ZERO;
    flashloanPremium.save();
  }
  return flashloanPremium;
}

export function readValue<T>(
  callResult: ethereum.CallResult<T>,
  defaultValue: T
): T {
  return callResult.reverted ? defaultValue : callResult.value;
}

export function rayToWad(a: BigInt): BigInt {
  const halfRatio = BigInt.fromI32(INT_TEN)
    .pow(INT_NINE as u8)
    .div(BigInt.fromI32(INT_TWO));
  return halfRatio.plus(a).div(BigInt.fromI32(INT_TEN).pow(INT_NINE as u8));
}


// n => 10^n
export function exponentToBigDecimal(decimals: i32): BigDecimal {
  let result = BIGINT_ONE;
  const ten = BigInt.fromI32(INT_TEN);
  for (let i = 0; i < decimals; i++) {
    result = result.times(ten);
  }
  return result.toBigDecimal();
}

export function equalsIgnoreCase(a: string, b: string): boolean {
  const DASH = "-";
  const UNDERSCORE = "_";
  return (
    a.replace(DASH, UNDERSCORE).toLowerCase() ==
    b.replace(DASH, UNDERSCORE).toLowerCase()
  );
}

// Use the Transfer event before Repay event to detect interestRateType
// We cannot use Burn event because a Repay event may actually mint
// new debt token if the repay amount is less than interest accrued

export function getInterestRateType(
  event: ethereum.Event
): InterestRateType | null {
  const TRANSFER = "Transfer(address,address,uint256)";
  const eventSignature = crypto.keccak256(ByteArray.fromUTF8(TRANSFER));
  const logs = event.receipt!.logs;
  // Transfer emitted at 4 or 5 index ahead of Repay's event.logIndex
  const logIndexMinus5 = event.logIndex.minus(BigInt.fromI32(INT_FIVE));
  const logIndexMinus3 = event.logIndex.minus(BigInt.fromI32(INT_THREE));

  for (let i = 0; i < logs.length; i++) {
    const thisLog = logs[i];
    if (thisLog.topics.length >= INT_THREE) {
      if (thisLog.logIndex.lt(logIndexMinus5)) {
        // skip event with logIndex < LogIndexMinus5
        continue;
      }
      if (thisLog.logIndex.equals(logIndexMinus3)) {
        // break if the logIndex = event.logIndex - 3
        break;
      }

      // topics[0] - signature
      const ADDRESS = "address";
      const logSignature = thisLog.topics[0];

      if (logSignature.equals(eventSignature)) {
        const from = ethereum
          .decode(ADDRESS, thisLog.topics.at(1))!
          .toAddress();
        const to = ethereum.decode(ADDRESS, thisLog.topics.at(2))!.toAddress();

        if (from.equals(Address.zero()) || to.equals(Address.zero())) {
          // this is a burn or mint event
          const tokenAddress = thisLog.address;
          const token = Token.load(tokenAddress);
          if (!token) {
            log.error("[getInterestRateType]token {} not found tx {}-{}", [
              tokenAddress.toHexString(),
              event.transaction.hash.toHexString(),
              event.transactionLogIndex.toString(),
            ]);
            return null;
          }

          if (token._izarbanTokenType == IzarbanTokenType.STOKEN) {
            return InterestRateType.STABLE;
          }
          if (token._izarbanTokenType == IzarbanTokenType.VTOKEN) {
            return InterestRateType.VARIABLE;
          }
        }
      }

      log.info(
        "[getInterestRateType]event at logIndex {} signature {} not match the expected Transfer signature {}. tx {}-{} ",
        [
          thisLog.logIndex.toString(),
          logSignature.toHexString(),
          eventSignature.toHexString(),
          event.transaction.hash.toHexString(),
          event.transactionLogIndex.toString(),
        ]
      );
    }
  }
  return null;
}

export function getFlashloanPremiumAmount(
  event: ethereum.Event,
  assetAddress: Address
): BigInt {
  let flashloanPremiumAmount = BIGINT_ZERO;
  const FLASHLOAN =
    "FlashLoan(address,address,address,uint256,uint8,uint256,uint16)";
  const eventSignature = crypto.keccak256(ByteArray.fromUTF8(FLASHLOAN));
  const logs = event.receipt!.logs;
  //ReserveDataUpdated emitted before Flashloan's event.logIndex
  // e.g. https://etherscan.io/tx/0xeb87ebc0a18aca7d2a9ffcabf61aa69c9e8d3c6efade9e2303f8857717fb9eb7#eventlog
  const ReserveDateUpdatedEventLogIndex = event.logIndex;
  for (let i = 0; i < logs.length; i++) {
    const thisLog = logs[i];
    if (thisLog.topics.length >= INT_THREE) {
      if (thisLog.logIndex.le(ReserveDateUpdatedEventLogIndex)) {
        // skip log before ReserveDataUpdated
        continue;
      }
      //FlashLoan Event equals ReserveDateUpdatedEventLogIndex + 2 or 3 (there may be an Approval event)
      if (
        thisLog.logIndex.gt(ReserveDateUpdatedEventLogIndex.plus(BIGINT_THREE))
      ) {
        // skip if no matched FlashLoan event at ReserveDateUpdatedEventLogIndex+3
        break;
      }

      // topics[0] - signature
      const ADDRESS = "address";
      const DATA_TYPE_TUPLE = "(address,uint256,uint8,uint256)";
      const logSignature = thisLog.topics[0];
      if (thisLog.address == event.address && logSignature == eventSignature) {
        log.info(
          "[getFlashloanPremiumAmount]tx={}-{} thisLog.logIndex={} thisLog.topics=(1:{},2:{}),thisLog.data={}",
          [
            event.transaction.hash.toHexString(),
            event.logIndex.toString(),
            thisLog.logIndex.toString(),
            thisLog.topics.at(1).toHexString(),
            thisLog.topics.at(2).toHexString(),
            thisLog.data.toHexString(),
          ]
        );
        const flashLoanAssetAddress = ethereum
          .decode(ADDRESS, thisLog.topics.at(2))!
          .toAddress();
        if (flashLoanAssetAddress.notEqual(assetAddress)) {
          //
          continue;
        }
        const decoded = ethereum.decode(DATA_TYPE_TUPLE, thisLog.data);
        if (!decoded) continue;

        const logData = decoded.toTuple();
        flashloanPremiumAmount = logData[3].toBigInt();
        break;
      }
    }
  }
  return flashloanPremiumAmount;
}

// flashLoanPremiumRateToProtocol is rate of flashLoan premium directly accrue to
// protocol treasury
export function calcuateFlashLoanPremiumToLPUSD(
  flashLoanPremiumUSD: BigDecimal,
  flashLoanPremiumRateToProtocol: BigDecimal
): BigDecimal {
  let premiumToLPUSD = BIGDECIMAL_ZERO;
  if (flashLoanPremiumRateToProtocol.gt(BIGDECIMAL_ZERO)) {
    premiumToLPUSD = flashLoanPremiumUSD.minus(
      flashLoanPremiumUSD.times(flashLoanPremiumRateToProtocol)
    );
  }
  return premiumToLPUSD;
}