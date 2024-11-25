import {
  Address,
  BigDecimal,
  BigInt,
  dataSource,
  ethereum,
  log,
} from "@graphprotocol/graph-ts";
import { PriceOracleUpdated } from "../generated/LendingPoolAddressesProvider/LendingPoolAddressesProvider";
import {
  FLASHLOAN_PREMIUM_TOTAL,
  getNetworkSpecificConstant,
  Protocol
} from "./helper/constants";
import {
  BorrowingDisabledOnReserve,
  BorrowingEnabledOnReserve,
  CollateralConfigurationChanged,
  ReserveActivated,
  ReserveDeactivated,
  ReserveFactorChanged,
  ReserveInitialized,
} from "../generated/LendingPoolConfigurator/LendingPoolConfigurator";
import {
  Borrow,
  Deposit,
  FlashLoan,
  LiquidationCall,
  Paused,
  Repay,
  ReserveDataUpdated,
  ReserveUsedAsCollateralDisabled,
  ReserveUsedAsCollateralEnabled,
  Unpaused,
  Withdraw,
  Swap,
} from "../generated/LendingPool/LendingPool";
import { ZToken } from "../generated/LendingPool/ZToken";
import { StableDebtToken } from "../generated/LendingPool/StableDebtToken";
import { VariableDebtToken } from "../generated/LendingPool/VariableDebtToken";

import {
  InterestRateMode,
  Network,
  SECONDS_PER_DAY,
  CollateralizationType,
  LendingType,
  PermissionType,
  RewardTokenType,
  RiskType,
  BIGDECIMAL_HUNDRED,
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  DEFAULT_DECIMALS,
  IzarbanTokenType,
  INT_FOUR,
  RAY_OFFSET,
  ZERO_ADDRESS,
  BIGINT_ONE_RAY,
  BIGDECIMAL_NEG_ONE_CENT,
  InterestRateSide,
  InterestRateType,
  OracleSource,
  PositionSide,
  TransactionType,
  FeeType,
  TokenType
} from "./helper/constants";
import {
  Account,
  Market,
  Token,
  Protocol as LendingProtocol,
  _DefaultOracle,
  _FlashLoanPremium,
} from "../generated/schema";
import { ZarbanIncentivesController } from "../generated/LendingPool/ZarbanIncentivesController";
import { StakedZarban } from "../generated/LendingPool/StakedZarban";
import { IPriceOracleGetter } from "../generated/LendingPool/IPriceOracleGetter";
import { BalanceTransfer as CollateralTransfer } from "../generated/templates/ZToken/ZToken";

import {
  equalsIgnoreCase,
  readValue,
  getBorrowBalances,
  getCollateralBalance,
  getMarketByAuxillaryToken,
  exponentToBigDecimal,
  rayToWad,
  getMarketFromToken,
  getOrCreateFlashloanPremium,
  getInterestRateType,
  getFlashloanPremiumAmount,
  calcuateFlashLoanPremiumToLPUSD,
  getPrincipal,
} from "./helper/helpers";

import { TokenManager } from "./helper/token";

import {
  ZToken as ZTokenTemplate,
  VariableDebtToken as VTokenTemplate,
  StableDebtToken as STokenTemplate,
} from "../generated/templates";
import { ERC20 } from "../generated/LendingPool/ERC20";
import { DataManager, ProtocolData, RewardData } from "./helper/manager";
import { AccountManager } from "./helper/account";
import { PositionManager } from "./helper/position";

function getProtocolData(): ProtocolData {
  const constants = getNetworkSpecificConstant();
  return new ProtocolData(
    constants.protocolAddress,
    Protocol.PROTOCOL,
    Protocol.NAME,
    Protocol.SLUG,
    constants.network,
    LendingType.POOLED,
    PermissionType.PERMISSIONLESS,
    PermissionType.PERMISSIONLESS,
    PermissionType.ADMIN,
    CollateralizationType.OVER_COLLATERALIZED,
    RiskType.GLOBAL
  );
}

const protocolData = getProtocolData();

///////////////////////////////////////////////
///// LendingPoolAddressProvider Handlers /////
///////////////////////////////////////////////


export function handlePriceOracleUpdated(event: PriceOracleUpdated): void {
  const newPriceOracle = event.params.newAddress;

  log.info("[_handlePriceOracleUpdated] New oracleAddress: {}", [
    newPriceOracle.toHexString(),
  ]);

  // since all Zarban markets share the same oracle
  // we will use _DefaultOracle entity for markets whose oracle is not set
  let defaultOracle = _DefaultOracle.load(protocolData.protocolID);
  if (!defaultOracle) {
    defaultOracle = new _DefaultOracle(protocolData.protocolID);
  }
  defaultOracle.oracle = newPriceOracle;
  defaultOracle.save();

  const protocol = LendingProtocol.load(protocolData.protocolID);
  let markets: Market[];
  if (protocol === null) {
    log.warning("[_handleUnpaused] LendingProtocol does not exist", []);
    return;
  } else {
    markets = protocol.markets.load();
  } if (!markets) {
    log.warning("[_handlePriceOracleUpdated] marketList for {} does not exist", [
      protocolData.protocolID.toHexString(),
    ]);
    return;
  }

  for (let i = 0; i < markets.length; i++) {
    const _market = Market.load(markets[i].id);
    if (!_market) {
      log.warning("[_handlePriceOracleUpdated] Market not found: {}", [
        markets[i].id.toHexString(),
      ]);
      continue;
    }
    const manager = new DataManager(
      markets[i].id,
      _market.inputToken,
      event,
      protocolData
    );
    _market.oracle = manager.getOrCreateOracle(
      newPriceOracle,
      true,
      OracleSource.CHAINLINK
    ).id;
    _market.save();
  }
}

//////////////////////////////////////
///// Lending Pool Configuration /////
//////////////////////////////////////

export function handleReserveInitialized(event: ReserveInitialized): void {

  const underlyingToken = event.params.asset;
  const outputToken = event.params.zToken;
  const variableDebtToken = event.params.variableDebtToken;
  const stableDebtToken = event.params.stableDebtToken || Address.fromString(ZERO_ADDRESS)

  // create VToken from template
  VTokenTemplate.create(variableDebtToken);
  // create ZToken from template
  ZTokenTemplate.create(outputToken);

  const manager = new DataManager(
    outputToken,
    underlyingToken,
    event,
    protocolData
  );
  const market = manager.getMarket();
  const outputTokenManager = new TokenManager(outputToken, event);
  const vDebtTokenManager = new TokenManager(
    variableDebtToken,
    event,
    TokenType.REBASING
  );
  market.outputToken = outputTokenManager.getToken().id;
  market.name = outputTokenManager._getName();
  market._vToken = vDebtTokenManager.getToken().id;

  // map tokens to market
  const inputToken = manager.getInputToken();
  inputToken._market = market.id;
  inputToken._izarbanTokenType = IzarbanTokenType.INPUTTOKEN;
  inputToken.save();

  const ZToken = outputTokenManager.getToken();
  ZToken._market = market.id;
  ZToken._izarbanTokenType = IzarbanTokenType.ZTOKEN;
  ZToken.save();

  const vToken = vDebtTokenManager.getToken();
  vToken._market = market.id;
  vToken._izarbanTokenType = IzarbanTokenType.VTOKEN;
  vToken.save();

  if (stableDebtToken != Address.zero()) {
    const sDebtTokenManager = new TokenManager(stableDebtToken, event);
    const sToken = sDebtTokenManager.getToken();
    sToken._market = market.id;
    sToken._izarbanTokenType = IzarbanTokenType.STOKEN;
    sToken.save();

    market._sToken = sToken.id;

    STokenTemplate.create(stableDebtToken);
  }

  const defaultOracle = _DefaultOracle.load(protocolData.protocolID);
  if (!market.oracle && defaultOracle) {
    market.oracle = manager.getOrCreateOracle(
      Address.fromBytes(defaultOracle.oracle),
      true,
      OracleSource.CHAINLINK
    ).id;
  }

  market.save();
}


export function handleCollateralConfigurationChanged(event: CollateralConfigurationChanged): void {
  const asset = event.params.asset;
  const liquidationPenalty = event.params.liquidationBonus;
  const liquidationThreshold = event.params.liquidationThreshold;
  const maximumLTV = event.params.ltv;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning(
      "[_handleCollateralConfigurationChanged] Market for asset {} not found",
      [asset.toHexString()]
    );
    return;
  }

  market.maximumLTV = maximumLTV.toBigDecimal().div(BIGDECIMAL_HUNDRED);
  market.liquidationThreshold = liquidationThreshold
    .toBigDecimal()
    .div(BIGDECIMAL_HUNDRED);

  // The liquidation bonus value is equal to the liquidation penalty, the naming is a matter of which side of the liquidation a user is on
  // The liquidationBonus parameter comes out as above 100%, represented by a 5 digit integer over 10000 (100%).
  // To extract the expected value in the liquidationPenalty field: convert to BigDecimal, subtract by 10000 and divide by 100
  const bdLiquidationPenalty = liquidationPenalty.toBigDecimal();
  if (bdLiquidationPenalty.gt(exponentToBigDecimal(INT_FOUR))) {
    market.liquidationPenalty = bdLiquidationPenalty
      .minus(exponentToBigDecimal(INT_FOUR))
      .div(BIGDECIMAL_HUNDRED);
  }

  market.save();
}

export function handleBorrowingEnabledOnReserve(event: BorrowingEnabledOnReserve): void {
  const asset = event.params.asset;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleBorrowingEnabledOnReserve] Market not found {}", [
      asset.toHexString(),
    ]);
    return;
  }

  market.canBorrowFrom = true;
  market.save();
}


export function handleBorrowingDisabledOnReserve(
  event: BorrowingDisabledOnReserve
): void {
  const asset = event.params.asset;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning(
      "[_handleBorrowingDisabledOnReserve] Market for token {} not found",
      [asset.toHexString()]
    );
    return;
  }

  market.canBorrowFrom = false;
  market.save();
}

export function handleReserveActivated(event: ReserveActivated): void {
  const asset = event.params.asset;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleReserveActivated] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }

  market.isActive = true;
  market.save();
}

export function handleReserveDeactivated(event: ReserveDeactivated): void {
  const asset = event.params.asset;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleReserveDeactivated] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }

  market.isActive = false;
  market.save();
}


export function handleReserveFactorChanged(event: ReserveFactorChanged): void {
  const asset = event.params.asset;
  const reserveFactor = event.params.factor;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleReserveFactorChanged] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }

  market.reserveFactor = reserveFactor
    .toBigDecimal()
    .div(exponentToBigDecimal(INT_FOUR));
  market.save();
}

/////////////////////////////////
///// Lending Pool Handlers /////
/////////////////////////////////


export function handleReserveDataUpdated(event: ReserveDataUpdated): void {

  const liquidityRate = event.params.liquidityRate // deposit rate in ray
  const liquidityIndex = event.params.liquidityIndex
  const variableBorrowIndex = event.params.variableBorrowIndex
  const variableBorrowRate = event.params.variableBorrowRate
  const stableBorrowRate = event.params.stableBorrowRate
  const asset = event.params.reserve

  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[handleReserveDataUpdated] Market not found for reserve {}", [
      event.params.reserve.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );

  updateRewards(manager, event);

  let assetPriceUSD = getAssetPriceInUSDC(
    Address.fromBytes(market.inputToken),
    manager.getOracleAddress(),
    event.block.number
  ) || BIGDECIMAL_ZERO;

  if (!market) {
    log.warning("[_handlReserveDataUpdated] Market for asset {} not found", [
      asset.toHexString(),
    ]);
    return;
  }


  const inputToken = manager.getInputToken();
  // get current borrow balance
  let trySBorrowBalance: ethereum.CallResult<BigInt> | null = null;
  if (market._sToken) {
    const stableDebtContract = StableDebtToken.bind(
      Address.fromBytes(market._sToken!)
    );
    trySBorrowBalance = stableDebtContract.try_totalSupply();
  }

  const variableDebtContract = VariableDebtToken.bind(
    Address.fromBytes(market._vToken!)
  );
  const tryVBorrowBalance = variableDebtContract.try_totalSupply();
  let sBorrowBalance = BIGINT_ZERO;
  let vBorrowBalance = BIGINT_ZERO;

  if (trySBorrowBalance != null && !trySBorrowBalance.reverted) {
    sBorrowBalance = trySBorrowBalance.value;
  }
  if (!tryVBorrowBalance.reverted) {
    vBorrowBalance = tryVBorrowBalance.value;
  }

  // broken if both revert
  if (
    trySBorrowBalance != null &&
    trySBorrowBalance.reverted &&
    tryVBorrowBalance.reverted
  ) {
    log.warning("[ReserveDataUpdated] No borrow balance found", []);
    return;
  }

  // update total supply balance
  const ZTokenContract = ZToken.bind(Address.fromBytes(market.outputToken!));
  const tryTotalSupply = ZTokenContract.try_totalSupply();
  if (tryTotalSupply.reverted) {
    log.warning(
      "[ReserveDataUpdated] Error getting total supply on market: {}",
      [market.id.toHexString()]
    );
    return;
  }

  if (assetPriceUSD.equals(BIGDECIMAL_ZERO)) {
    assetPriceUSD = market.inputTokenPriceUSD;
  }
  manager.updateMarketAndProtocolData(
    assetPriceUSD,
    tryTotalSupply.value,
    vBorrowBalance,
    sBorrowBalance,
    tryTotalSupply.value
  );

  const tryScaledSupply = ZTokenContract.try_scaledTotalSupply();
  if (tryScaledSupply.reverted) {
    log.warning(
      "[ReserveDataUpdated] Error getting scaled total supply on market: {}",
      [asset.toHexString()]
    );
    return;
  }

  // calculate new revenue
  // New Interest = totalScaledSupply * (difference in liquidity index)
  let currSupplyIndex = market.supplyIndex;
  if (!currSupplyIndex) {
    manager.updateSupplyIndex(BIGINT_ONE_RAY);
    currSupplyIndex = BIGINT_ONE_RAY;
  }
  const liquidityIndexDiff = liquidityIndex
    .minus(currSupplyIndex)
    .toBigDecimal()
    .div(exponentToBigDecimal(RAY_OFFSET));
  manager.updateSupplyIndex(liquidityIndex); // must update to current liquidity index
  manager.updateBorrowIndex(variableBorrowIndex);

  const newRevenueBD = tryScaledSupply.value
    .toBigDecimal()
    .div(exponentToBigDecimal(inputToken.decimals))
    .times(liquidityIndexDiff);
  let totalRevenueDeltaUSD = newRevenueBD.times(assetPriceUSD);

  const receipt = event.receipt;
  let FlashLoanPremiumToLPUSD = BIGDECIMAL_ZERO;
  if (!receipt) {
    log.warning(
      "[_handleReserveDataUpdated]No receipt for tx {}; cannot subtract Flashloan revenue",
      [event.transaction.hash.toHexString()]
    );
  } else {
    const flashLoanPremiumAmount = getFlashloanPremiumAmount(event, asset);
    const flashLoanPremiumUSD = flashLoanPremiumAmount
      .toBigDecimal()
      .div(exponentToBigDecimal(inputToken.decimals))
      .times(assetPriceUSD);
    const flashloanPremium = getOrCreateFlashloanPremium(protocolData);
    FlashLoanPremiumToLPUSD = calcuateFlashLoanPremiumToLPUSD(
      flashLoanPremiumUSD,
      flashloanPremium.premiumRateToProtocol
    );
  }

  // deduct flashloan premium that may have already been accounted for in
  // _handleFlashloan()
  totalRevenueDeltaUSD = totalRevenueDeltaUSD.minus(FlashLoanPremiumToLPUSD);
  if (
    totalRevenueDeltaUSD.lt(BIGDECIMAL_ZERO) &&
    totalRevenueDeltaUSD.gt(BIGDECIMAL_NEG_ONE_CENT)
  ) {
    // totalRevenueDeltaUSD may become a tiny negative number after
    // subtracting flashloan premium due to rounding
    totalRevenueDeltaUSD = BIGDECIMAL_ZERO;
  }
  let reserveFactor = market.reserveFactor;
  if (!reserveFactor) {
    log.warning(
      "[_handleReserveDataUpdated]reserveFactor = null for market {}, default to 0.0",
      [asset.toHexString()]
    );
    reserveFactor = BIGDECIMAL_ZERO;
  }

  const protocolSideRevenueDeltaUSD = totalRevenueDeltaUSD.times(reserveFactor);
  const supplySideRevenueDeltaUSD = totalRevenueDeltaUSD.minus(
    protocolSideRevenueDeltaUSD
  );

  const fee = manager.getOrUpdateFee(
    FeeType.PROTOCOL_FEE,
    market.reserveFactor
  );

  manager.addProtocolRevenue(protocolSideRevenueDeltaUSD, fee);
  manager.addSupplyRevenue(supplySideRevenueDeltaUSD, fee);

  manager.getOrUpdateRate(
    InterestRateSide.BORROWER,
    InterestRateType.VARIABLE,
    rayToWad(variableBorrowRate)
      .toBigDecimal()
      .div(exponentToBigDecimal(DEFAULT_DECIMALS - 2))
  );

  if (market._sToken) {
    // geist does not have stable borrow rates
    manager.getOrUpdateRate(
      InterestRateSide.BORROWER,
      InterestRateType.STABLE,
      rayToWad(stableBorrowRate)
        .toBigDecimal()
        .div(exponentToBigDecimal(DEFAULT_DECIMALS - 2))
    );
  }

  manager.getOrUpdateRate(
    InterestRateSide.LENDER,
    InterestRateType.VARIABLE,
    rayToWad(liquidityRate)
      .toBigDecimal()
      .div(exponentToBigDecimal(DEFAULT_DECIMALS - 2))
  );
}

export function handleReserveUsedAsCollateralEnabled(event: ReserveUsedAsCollateralEnabled): void {
  // This Event handler enables a reserve/market to be used as collateral
  const asset = event.params.reserve;
  const accountID = event.params.user;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning(
      "[_handleReserveUsedAsCollateralEnabled] Market for token {} not found",
      [asset.toHexString()]
    );
    return;
  }
  const accountManager = new AccountManager(accountID);
  const account = accountManager.getAccount();

  const markets = account._enabledCollaterals
    ? account._enabledCollaterals!
    : [];
  markets.push(market.id);
  account._enabledCollaterals = markets;

  account.save();
}

export function handleReserveUsedAsCollateralDisabled(event: ReserveUsedAsCollateralDisabled): void {
  // This Event handler disables a reserve/market being used as collateral
  const asset = event.params.reserve;
  const accountID = event.params.user;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning(
      "[_handleReserveUsedAsCollateralEnabled] Market for token {} not found",
      [asset.toHexString()]
    );
    return;
  }
  const accountManager = new AccountManager(accountID);
  const account = accountManager.getAccount();

  const markets = account._enabledCollaterals
    ? account._enabledCollaterals!
    : [];

  const index = markets.indexOf(market.id);
  if (index >= 0) {
    // drop 1 element at given index
    markets.splice(index, 1);
  }
  account._enabledCollaterals = markets;
  account.save();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handlePaused(event: Paused): void {
  const protocol = LendingProtocol.load(protocolData.protocolID);
  let markets: Market[];
  if (protocol === null) {
    log.warning("[_handleUnpaused] LendingProtocol does not exist", []);
    return;
  } else {
    markets = protocol.markets.load();
  }
  if (!markets) {
    log.warning("[_handlePaused]marketList for {} does not exist", [
      protocolData.protocolID.toHexString(),
    ]);
    return;
  }

  for (let i = 0; i < markets.length; i++) {
    const market = Market.load(markets[i].id);
    if (!market) {
      log.warning("[Paused] Market not found: {}", [markets[i].id.toHexString()]);
      continue;
    }

    market.isActive = false;
    market.canUseAsCollateral = false;
    market.canBorrowFrom = false;
    market.save();
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handleUnpaused(event: Unpaused): void {
  const protocol = LendingProtocol.load(protocolData.protocolID);
  let markets: Market[];
  if (protocol === null) {
    log.warning("[_handleUnpaused] LendingProtocol does not exist", []);
    return;
  } else {
    markets = protocol.markets.load();
  }
  if (!markets) {
    log.warning("[_handleUnpaused]marketList for {} does not exist", [
      protocolData.protocolID.toHexString(),
    ]);
    return;
  }

  for (let i = 0; i < markets.length; i++) {
    const market = Market.load(markets[i].id);
    if (!market) {
      log.warning("[_handleUnpaused] Market not found: {}", [
        markets[i].id.toHexString(),
      ]);
      continue;
    }

  }
}

export function handleDeposit(event: Deposit): void {
  const amount = event.params.amount;
  const asset = event.params.reserve;
  const accountID = event.params.onBehalfOf;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleDeposit] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const tokenManager = new TokenManager(asset, event, TokenType.REBASING);
  const amountUSD = tokenManager.getAmountUSD(amount);
  const newCollateralBalance = getCollateralBalance(market, accountID);
  const principal = getPrincipal(market, accountID, PositionSide.COLLATERAL);
  manager.createDeposit(
    asset,
    accountID,
    amount,
    amountUSD,
    newCollateralBalance,
    null,
    principal
  );
  const account = Account.load(accountID);
  if (!account) {
    log.warning("[_handleDeposit]account {} not found", [
      accountID.toHexString(),
    ]);
    return;
  }
  const positionManager = new PositionManager(
    account,
    market,
    PositionSide.COLLATERAL
  );
  if (
    !account._enabledCollaterals ||
    account._enabledCollaterals!.indexOf(market.id) == -1
  ) {
    return;
  }
  positionManager.setCollateral(true);

}

export function handleWithdraw(event: Withdraw): void {
  const amount = event.params.amount;
  const asset = event.params.reserve;
  const accountID = event.params.user;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleWithdraw] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const tokenManager = new TokenManager(asset, event, TokenType.REBASING);
  const amountUSD = tokenManager.getAmountUSD(amount);
  const newCollateralBalance = getCollateralBalance(market, accountID);
  const principal = getPrincipal(market, accountID, PositionSide.COLLATERAL);
  manager.createWithdraw(
    asset,
    accountID,
    amount,
    amountUSD,
    newCollateralBalance,
    null,
    principal
  );
}


export function handleBorrow(event: Borrow): void {

  const amount = event.params.amount;
  const asset = event.params.reserve;
  const accountID = event.params.onBehalfOf;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleBorrow] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const tokenManager = new TokenManager(asset, event, TokenType.REBASING);
  const amountUSD = tokenManager.getAmountUSD(amount);
  const newBorrowBalances = getBorrowBalances(market, accountID);
  const principal = getPrincipal(
    market,
    accountID,
    PositionSide.BORROWER,
  );

  manager.createBorrow(
    asset,
    accountID,
    amount,
    amountUSD,
    newBorrowBalances[0].plus(newBorrowBalances[1]),
    market.inputTokenPriceUSD,
    null,
    principal
  );
}

export function handleRepay(event: Repay): void {
  const amount = event.params.amount;
  const asset = event.params.reserve;
  const accountID = event.params.user;
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleRepay] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const tokenManager = new TokenManager(asset, event, TokenType.REBASING);
  const amountUSD = tokenManager.getAmountUSD(amount);
  const newBorrowBalances = getBorrowBalances(market, accountID);

  // use debtToken Transfer event for Burn/Mint to determine interestRateType of the Repay event
  const interestRateType = getInterestRateType(event);
  if (!interestRateType) {
    log.error(
      "[_handleRepay]Cannot determine interest rate type for Repay event {}-{}",
      [
        event.transaction.hash.toHexString(),
        event.transactionLogIndex.toString(),
      ]
    );
  }

  const principal = getPrincipal(
    market,
    accountID,
    PositionSide.BORROWER,
    interestRateType
  );

  manager.createRepay(
    asset,
    accountID,
    amount,
    amountUSD,
    newBorrowBalances[0].plus(newBorrowBalances[1]),
    market.inputTokenPriceUSD,
    interestRateType,
    principal
  );
}

export function handleLiquidationCall(event: LiquidationCall): void {

  const amount = event.params.liquidatedCollateralAmount; // amount of collateral liquidated
  const collateralAsset = event.params.collateralAsset; // collateral market
  const liquidator = event.params.liquidator;
  const liquidatee = event.params.user; // account liquidated
  const debtAsset = event.params.debtAsset; // token repaid to cover debt,
  const debtToCover = event.params.debtToCover; // the amount of debt repaid by liquidator

  const market = getMarketFromToken(collateralAsset, protocolData);
  if (!market) {
    log.warning("[_handleLiquidate] Market for token {} not found", [
      collateralAsset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const inputToken = manager.getInputToken();
  let inputTokenPriceUSD = market.inputTokenPriceUSD;
  if (!inputTokenPriceUSD) {
    log.warning(
      "[_handleLiquidate] Price of input token {} is not set, default to 0.0",
      [inputToken.id.toHexString()]
    );
    inputTokenPriceUSD = BIGDECIMAL_ZERO;
  }
  const amountUSD = amount
    .toBigDecimal()
    .div(exponentToBigDecimal(inputToken.decimals))
    .times(inputTokenPriceUSD);

  if (!market._liquidationProtocolFee) {
    // liquidationProtocolFee is only set for v3 markets
    log.warning(
      "[_handleLiquidate]market {} _liquidationProtocolFee = null. Must be a v2 market, setting to 0.",
      [collateralAsset.toHexString()]
    );
    market._liquidationProtocolFee = BIGDECIMAL_ZERO;
    market.save();
  }
  let liquidationProtocolFeeUSD = BIGDECIMAL_ZERO;

  const fee = manager.getOrUpdateFee(
    FeeType.LIQUIDATION_FEE,
    market._liquidationProtocolFee
  );
  manager.addProtocolRevenue(liquidationProtocolFeeUSD, fee);

  const debtTokenMarket = getMarketFromToken(debtAsset, protocolData);
  if (!debtTokenMarket) {
    log.warning("[_handleLiquidate] market for Debt token  {} not found", [
      debtAsset.toHexString(),
    ]);
    return;
  }
  let debtTokenPriceUSD = debtTokenMarket.inputTokenPriceUSD;
  if (!debtTokenPriceUSD) {
    log.warning(
      "[_handleLiquidate] Price of token {} is not set, default to 0.0",
      [debtAsset.toHexString()]
    );
    debtTokenPriceUSD = BIGDECIMAL_ZERO;
  }
  const profitUSD = amountUSD.minus(
    debtToCover.toBigDecimal().times(debtTokenPriceUSD)
  );
  const collateralBalance = getCollateralBalance(market, liquidatee);
  const debtBalances = getBorrowBalances(debtTokenMarket, liquidatee);
  const totalDebtBalance = debtBalances[0].plus(debtBalances[1]);
  const subtractBorrowerPosition = false;
  const collateralPrincipal = getPrincipal(
    market,
    liquidatee,
    PositionSide.COLLATERAL
  );
  const liquidate = manager.createLiquidate(
    collateralAsset,
    debtAsset,
    liquidator,
    liquidatee,
    amount,
    amountUSD,
    profitUSD,
    collateralBalance,
    totalDebtBalance,
    null,
    subtractBorrowerPosition,
    collateralPrincipal
  );
  if (!liquidate) {
    return;
  }

  const liquidatedPositions = liquidate.positions;
  const liquidateeAccount = new AccountManager(liquidatee).getAccount();
  const protocol = manager.getOrCreateProtocol(protocolData);
  // Use the Transfer event for debtToken to burn to determine the interestRateType for debtToken liquidated

  // Variable debt is liquidated first
  const vBorrowerPosition = new PositionManager(
    liquidateeAccount,
    debtTokenMarket,
    PositionSide.BORROWER,
    InterestRateType.VARIABLE
  );

  const vBorrowerPositionBalance = vBorrowerPosition._getPositionBalance();
  if (vBorrowerPositionBalance && vBorrowerPositionBalance.gt(BIGINT_ZERO)) {
    const vPrincipal = getPrincipal(
      market,
      Address.fromBytes(liquidateeAccount.id),
      PositionSide.BORROWER,
      InterestRateType.VARIABLE
    );
    vBorrowerPosition.subtractPosition(
      event,
      protocol,
      debtBalances[1],
      TransactionType.LIQUIDATE,
      debtTokenMarket.inputTokenPriceUSD,
      vPrincipal
    );
    liquidatedPositions.push(vBorrowerPosition.getPositionID()!);
  }

  const sBorrowerPosition = new PositionManager(
    liquidateeAccount,
    debtTokenMarket,
    PositionSide.BORROWER,
    InterestRateType.STABLE
  );

  const sBorrowerPositionBalance = sBorrowerPosition._getPositionBalance();
  // Stable debt is liquidated after exhuasting variable debt
  if (
    debtBalances[1].equals(BIGINT_ZERO) &&
    sBorrowerPositionBalance &&
    sBorrowerPositionBalance.gt(BIGINT_ZERO)
  ) {
    const sPrincipal = getPrincipal(
      market,
      Address.fromBytes(liquidateeAccount.id),
      PositionSide.BORROWER,
      InterestRateType.STABLE
    );
    sBorrowerPosition.subtractPosition(
      event,
      protocol,
      debtBalances[0],
      TransactionType.LIQUIDATE,
      debtTokenMarket.inputTokenPriceUSD,
      sPrincipal
    );
    liquidatedPositions.push(sBorrowerPosition.getPositionID()!);
  }

  liquidate.positions = liquidatedPositions;
  liquidate.save();
}

export function handleFlashloan(event: FlashLoan): void {
  const flashloanPremium = getOrCreateFlashloanPremium(protocolData);
  flashloanPremium.premiumRateTotal = FLASHLOAN_PREMIUM_TOTAL;
  flashloanPremium.save();

  const asset = event.params.asset;
  const amount = event.params.amount;
  const account = event.params.initiator;
  const premiumAmount = event.params.premium;

  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleFlashLoan] market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const tokenManager = new TokenManager(asset, event);
  const amountUSD = tokenManager.getAmountUSD(amount);
  const flashloan = manager.createFlashloan(
    asset,
    account,
    amount,
    amountUSD
  );
  const premiumUSDTotal = tokenManager.getAmountUSD(premiumAmount);
  flashloan.feeAmount = premiumAmount;
  flashloan.feeAmountUSD = premiumUSDTotal;
  flashloan.save();

  let premiumUSDToProtocol = BIGDECIMAL_ZERO;
  if (flashloanPremium.premiumRateToProtocol.gt(BIGDECIMAL_ZERO)) {
    // premium to protocol = total premium * premiumRateToProtocol
    premiumUSDToProtocol = premiumUSDTotal.times(
      flashloanPremium.premiumRateToProtocol
    );
    const feeToProtocol = manager.getOrUpdateFee(
      FeeType.FLASHLOAN_PROTOCOL_FEE,
      flashloanPremium.premiumRateToProtocol
    );
    manager.addProtocolRevenue(premiumUSDToProtocol, feeToProtocol);
  }

  // flashloan premium to LP is accrued in liquidityIndex and handled in
  // _handleReserveDataUpdated;
  const premiumRateToLP = flashloanPremium.premiumRateTotal.minus(
    flashloanPremium.premiumRateToProtocol
  );
  const feeToLP = manager.getOrUpdateFee(
    FeeType.FLASHLOAN_LP_FEE,
    premiumRateToLP
  );

  const premiumUSDToLP = premiumUSDTotal.minus(premiumUSDToProtocol);
  manager.addSupplyRevenue(premiumUSDToLP, feeToLP);
}


export function handleSwapBorrowRateMode(event: Swap): void {
  const interestRateMode = event.params.rateMode.toI32();
  if (
    ![InterestRateMode.STABLE, InterestRateMode.VARIABLE].includes(
      interestRateMode
    )
  ) {
    log.error(
      "[handleSwapBorrowRateMode]interestRateMode {} is not one of [{}, {}]",
      [
        interestRateMode.toString(),
        InterestRateMode.STABLE.toString(),
        InterestRateMode.VARIABLE.toString(),
      ]
    );
    return;
  }

  const interestRateType =
    interestRateMode === InterestRateMode.STABLE
      ? InterestRateType.STABLE
      : InterestRateType.VARIABLE;
  const market = getMarketFromToken(event.params.reserve, protocolData);
  if (!market) {
    log.error("[handleLiquidationCall]Failed to find market for asset {}", [
      event.params.reserve.toHexString(),
    ]);
    return;
  }

  const user = event.params.user;
  const newBorrowBalances = getBorrowBalances(market, event.params.user);
  const account = new AccountManager(user).getAccount();
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const protocol = manager.getOrCreateProtocol(protocolData);
  const sPositionManager = new PositionManager(
    account,
    market,
    PositionSide.BORROWER,
    InterestRateType.STABLE
  );
  const vPositionManager = new PositionManager(
    account,
    market,
    PositionSide.BORROWER,
    InterestRateType.VARIABLE
  );
  const stableTokenBalance = newBorrowBalances[0];
  const variableTokenBalance = newBorrowBalances[1];
  const vPrincipal = getPrincipal(
    market,
    Address.fromBytes(account.id),
    PositionSide.BORROWER,
    InterestRateType.VARIABLE
  );
  const sPrincipal = getPrincipal(
    market,
    Address.fromBytes(account.id),
    PositionSide.BORROWER,
    InterestRateType.STABLE
  );
  //all open position converted to STABLE
  if (interestRateType === InterestRateType.STABLE) {
    vPositionManager.subtractPosition(
      event,
      protocol,
      variableTokenBalance,
      TransactionType.SWAP,
      market.inputTokenPriceUSD,
      vPrincipal
    );
    sPositionManager.addPosition(
      event,
      market.inputToken,
      protocol,
      stableTokenBalance,
      TransactionType.SWAP,
      market.inputTokenPriceUSD,
      sPrincipal
    );
  } else {
    //all open position converted to VARIABLE
    vPositionManager.addPosition(
      event,
      market.inputToken,
      protocol,
      variableTokenBalance,
      TransactionType.SWAP,
      market.inputTokenPriceUSD,
      vPrincipal
    );
    sPositionManager.subtractPosition(
      event,
      protocol,
      stableTokenBalance,
      TransactionType.SWAP,
      market.inputTokenPriceUSD,
      sPrincipal
    );
  }


  //all open position converted to STABLE
  if (interestRateType === InterestRateType.STABLE) {
    vPositionManager.subtractPosition(
      event,
      protocol,
      variableTokenBalance,
      TransactionType.SWAP,
      market.inputTokenPriceUSD,
      vPrincipal
    );
    sPositionManager.addPosition(
      event,
      market.inputToken,
      protocol,
      stableTokenBalance,
      TransactionType.SWAP,
      market.inputTokenPriceUSD,
      sPrincipal
    );
  } else {
    //all open position converted to VARIABLE
    vPositionManager.addPosition(
      event,
      market.inputToken,
      protocol,
      variableTokenBalance,
      TransactionType.SWAP,
      market.inputTokenPriceUSD,
      vPrincipal
    );
    sPositionManager.subtractPosition(
      event,
      protocol,
      stableTokenBalance,
      TransactionType.SWAP,
      market.inputTokenPriceUSD,
      sPrincipal
    );
  }
}

/////////////////////////
//// Transfer Events ////
/////////////////////////

export function handleCollateralTransfer(event: CollateralTransfer): void {

  const positionSide = PositionSide.COLLATERAL;
  const to = event.params.to;
  const from = event.params.from;
  const amount = event.params.value;
  const asset = event.address;
  const market = getMarketByAuxillaryToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleTransfer] market not found: {}", [
      asset.toHexString(),
    ]);
    return;
  }

  // if the to / from addresses are the same as the asset
  // then this transfer is emitted as part of another event
  // ie, a deposit, withdraw, borrow, repay, etc
  // we want to let that handler take care of position updates
  // and zero addresses mean it is a part of a burn / mint
  if (
    to == Address.fromString(ZERO_ADDRESS) ||
    from == Address.fromString(ZERO_ADDRESS) ||
    to == asset ||
    from == asset
  ) {
    return;
  }

  const tokenContract = ERC20.bind(asset);
  const senderBalanceResult = tokenContract.try_balanceOf(from);
  const receiverBalanceResult = tokenContract.try_balanceOf(to);
  if (senderBalanceResult.reverted) {
    log.warning(
      "[_handleTransfer]token {} balanceOf() call for account {} reverted",
      [asset.toHexString(), from.toHexString()]
    );
    return;
  }
  if (receiverBalanceResult.reverted) {
    log.warning(
      "[_handleTransfer]token {} balanceOf() call for account {} reverted",
      [asset.toHexString(), to.toHexString()]
    );
    return;
  }
  const tokenManager = new TokenManager(asset, event);
  const assetToken = tokenManager.getToken();
  let interestRateType: string | null;
  if (assetToken._izarbanTokenType! == IzarbanTokenType.STOKEN) {
    interestRateType = InterestRateType.STABLE;
  } else if (assetToken._izarbanTokenType! == IzarbanTokenType.VTOKEN) {
    interestRateType = InterestRateType.VARIABLE;
  } else {
    interestRateType = null;
  }

  const senderPrincipal = getPrincipal(
    market,
    from,
    positionSide,
    interestRateType
  );
  const receiverPrincipal = getPrincipal(
    market,
    to,
    positionSide,
    interestRateType
  );

  const inputTokenManager = new TokenManager(market.inputToken, event);
  const amountUSD = inputTokenManager.getAmountUSD(amount);
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  manager.createTransfer(
    asset,
    from,
    to,
    amount,
    amountUSD,
    senderBalanceResult.value,
    receiverBalanceResult.value,
    interestRateType,
    senderPrincipal,
    receiverPrincipal
  );
}

///////////////////
///// Helpers /////
///////////////////

function getAssetPriceInUSDC(
  tokenAddress: Address,
  priceOracle: Address,
  blockNumber: BigInt
): BigDecimal {
  const oracle = IPriceOracleGetter.bind(priceOracle);
  let oracleResult = readValue<BigInt>(
    oracle.try_getAssetPrice(tokenAddress),
    BIGINT_ZERO
  );

  // if the result is zero or less, try the fallback oracle
  if (!oracleResult.gt(BIGINT_ZERO)) {
    const tryFallback = oracle.try_getFallbackOracle();
    if (tryFallback) {
      const fallbackOracle = IPriceOracleGetter.bind(tryFallback.value);
      oracleResult = readValue<BigInt>(
        fallbackOracle.try_getAssetPrice(tokenAddress),
        BIGINT_ZERO
      );
    }
  }



  // last resort, should not be touched
  const inputToken = Token.load(tokenAddress);
  if (!inputToken) {
    log.warning(
      "[getAssetPriceInUSDC]token {} not found in Token entity; return BIGDECIMAL_ZERO",
      [tokenAddress.toHexString()]
    );
    return BIGDECIMAL_ZERO;
  }
  return oracleResult
    .toBigDecimal()
    .div(exponentToBigDecimal(8));
}

function updateRewards(manager: DataManager, event: ethereum.Event): void {
  // Reward rate (rewards/second) in a market comes from try_assets(to)
  // Supply side the to address is the ZToken
  // Borrow side the to address is the variableDebtToken
  const market = manager.getMarket();
  const ZTokenContract = ZToken.bind(Address.fromBytes(market.outputToken!));
  const tryIncentiveController = ZTokenContract.try_getIncentivesController();
  if (tryIncentiveController.reverted) {
    log.warning(
      "[updateRewards]getIncentivesController() call for ZToken {} is reverted",
      [market.outputToken!.toHexString()]
    );
    return;
  }
  const incentiveControllerContract = ZarbanIncentivesController.bind(
    tryIncentiveController.value
  );
  const tryBorrowRewards = incentiveControllerContract.try_assets(
    Address.fromBytes(market._vToken!)
  );
  const trySupplyRewards = incentiveControllerContract.try_assets(
    Address.fromBytes(market.outputToken!)
  );
  const tryRewardAsset = incentiveControllerContract.try_REWARD_TOKEN();

  if (tryRewardAsset.reverted) {
    log.warning(
      "[updateRewards]REWARD_TOKEN() call for ZarbanIncentivesController contract {} is reverted",
      [tryIncentiveController.value.toHexString()]
    );
    return;
  }
  // create reward tokens
  const tokenManager = new TokenManager(tryRewardAsset.value, event);
  const rewardToken = tokenManager.getToken();
  const vBorrowRewardToken = tokenManager.getOrCreateRewardToken(
    RewardTokenType.VARIABLE_BORROW
  );
  const sBorrowRewardToken = tokenManager.getOrCreateRewardToken(
    RewardTokenType.STABLE_BORROW
  );
  const depositRewardToken = tokenManager.getOrCreateRewardToken(
    RewardTokenType.DEPOSIT
  );

  const rewardDecimals = rewardToken.decimals;
  const defaultOracle = _DefaultOracle.load(protocolData.protocolID);
  // get reward token price
  // get price of reward token (if stkZarban it is tied to the price of Zarban)
  let rewardTokenPriceUSD = BIGDECIMAL_ZERO;
  if (
    equalsIgnoreCase(dataSource.network(), Network.ARBITRUM_ONE) &&
    defaultOracle &&
    defaultOracle.oracle
  ) {
    // get staked token if possible to grab price of staked token
    const stakedTokenContract = StakedZarban.bind(tryRewardAsset.value);
    const tryStakedToken = stakedTokenContract.try_STAKED_TOKEN();
    if (!tryStakedToken.reverted) {
      rewardTokenPriceUSD = getAssetPriceInUSDC(
        tryStakedToken.value,
        Address.fromBytes(defaultOracle.oracle),
        event.block.number
      );
    }
  }

  // if reward token price was not found then use old method
  if (
    rewardTokenPriceUSD.equals(BIGDECIMAL_ZERO) &&
    defaultOracle &&
    defaultOracle.oracle
  ) {
    rewardTokenPriceUSD = getAssetPriceInUSDC(
      tryRewardAsset.value,
      Address.fromBytes(defaultOracle.oracle),
      event.block.number
    );
  }

  // we check borrow first since it will show up first in graphql ordering
  // see explanation in docs/Mapping.md#Array Sorting When Querying
  if (!tryBorrowRewards.reverted) {
    // update borrow rewards
    const borrowRewardsPerDay = tryBorrowRewards.value.value0.times(
      BigInt.fromI32(SECONDS_PER_DAY)
    );
    const borrowRewardsPerDayUSD = borrowRewardsPerDay
      .toBigDecimal()
      .div(exponentToBigDecimal(rewardDecimals))
      .times(rewardTokenPriceUSD);

    const vBorrowRewardData = new RewardData(
      vBorrowRewardToken,
      borrowRewardsPerDay,
      borrowRewardsPerDayUSD
    );
    const sBorrowRewardData = new RewardData(
      sBorrowRewardToken,
      borrowRewardsPerDay,
      borrowRewardsPerDayUSD
    );
    manager.updateRewards(vBorrowRewardData);
    manager.updateRewards(sBorrowRewardData);
  }

  if (!trySupplyRewards.reverted) {
    // update deposit rewards
    const supplyRewardsPerDay = trySupplyRewards.value.value0.times(
      BigInt.fromI32(SECONDS_PER_DAY)
    );
    const supplyRewardsPerDayUSD = supplyRewardsPerDay
      .toBigDecimal()
      .div(exponentToBigDecimal(rewardDecimals))
      .times(rewardTokenPriceUSD);
    const depositRewardData = new RewardData(
      depositRewardToken,
      supplyRewardsPerDay,
      supplyRewardsPerDayUSD
    );
    manager.updateRewards(depositRewardData);
  }
}