# Solana SPL token claimer

Similar in Solidity:

https://gist.github.com/Vectorized/88987c8c42df60d512cdefd578f0e1c9

## Requirements

- Rust
- Solana
- Anchor
- Yarn

## Overview

Uses a bitmap to mark an indexed claim as used.

Each claim has:

- claim index  
- source token account (on Solana, each balance each SPL token for each owner occupied its own account)  
- amount  

For more info, ask me.

## Safety

This is **experimental software** and is provided on an "as is" and "as available" basis.

We **do not give any warranties** and **will not be liable for any loss** incurred through any use of this codebase.

