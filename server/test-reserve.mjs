/**
 * Monad's 10 MON reserve balance, applied to the onboarding relayer.
 *
 * On a Monad network an EOA whose value spend would leave it under 10 MON
 * reverts (and still pays gas). anvil does not enforce this, so the rule is a
 * pure function and tested here.
 *
 *   node test-reserve.mjs
 */
import { parseEther } from 'viem';
import { dripIsReserveSafe, isMonadNetwork, MONAD_RESERVE, relayerNeeds } from './onboard.js';
import { tally } from './test-util.mjs';

const { check, done } = tally();
const drip = parseEther('0.25');
const gasCost = parseEther('0.01');

check('10143 and 143 are Monad networks; the local fork is not', isMonadNetwork(10143) && isMonadNetwork(143) && !isMonadNetwork(31337));
check('the reserve is 10 MON', MONAD_RESERVE === parseEther('10'));
check('on testnet the relayer needs gas + drip + 10 MON before onboarding anyone',
  relayerNeeds({ chainId: 10143, drip }) === parseEther('0.2') + drip + parseEther('10'));
check('on the local fork it needs gas + drip only', relayerNeeds({ chainId: 31337, drip }) === parseEther('0.2') + drip);
check('a drip that keeps ≥ 10 MON is allowed on testnet', dripIsReserveSafe({ chainId: 10143, balance: parseEther('10.3'), drip, gasCost }));
check('a drip that would dip under 10 MON is refused on testnet (it would revert)',
  !dripIsReserveSafe({ chainId: 10143, balance: parseEther('10.2'), drip, gasCost }));
check('the same balance is fine on the fork (no reserve rule there)', dripIsReserveSafe({ chainId: 31337, balance: parseEther('10.2'), drip, gasCost }));
check('an empty relayer is refused everywhere', !dripIsReserveSafe({ chainId: 31337, balance: 0n, drip, gasCost }) && !dripIsReserveSafe({ chainId: 10143, balance: 0n, drip, gasCost }));
process.exit(done() ? 1 : 0);
