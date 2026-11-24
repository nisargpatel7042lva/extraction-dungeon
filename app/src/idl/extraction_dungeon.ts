/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/extraction_dungeon.json`.
 */
export type ExtractionDungeon = {
  "address": "2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw",
  "metadata": {
    "name": "extractionDungeon",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "attack",
      "docs": [
        "ER. Hits the active player on the adjacent tile in `dir` for 1 damage, at most once per",
        "ATTACK_COOLDOWN_SLOTS. A kill drops the victim's whole bag on their tile.",
        "remaining_accounts: every seat's Bag, in seat order."
      ],
      "discriminator": [
        197,
        26,
        63,
        242,
        77,
        247,
        101,
        119
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "dir",
          "type": "u8"
        }
      ]
    },
    {
      "name": "callbackOpenChest",
      "docs": [
        "VRF callback. The tier goes into the opener's private Bag; the Run only learns \"opened\".",
        "Loot goes into the opener's bag, or their sack if they died while it was opening."
      ],
      "discriminator": [
        229,
        73,
        121,
        9,
        42,
        10,
        19,
        43
      ],
      "accounts": [
        {
          "name": "vrfProgramIdentity",
          "signer": true,
          "address": "93wpAbykB2TVLRWdKsXVkq4LPkUbVXN1Fg9YqAetEPoK"
        },
        {
          "name": "run",
          "writable": true
        },
        {
          "name": "bag",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "randomness",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "chest",
          "type": "u8"
        },
        {
          "name": "seat",
          "type": "u8"
        }
      ]
    },
    {
      "name": "cancelRun",
      "docs": [
        "Base. Cancels a run that never started and refunds every stake. The host can cancel at any",
        "time while it's in the lobby; anyone can once it has waited LOBBY_TIMEOUT_SECS, so stakes",
        "are never stuck behind a host who walked away.",
        "remaining_accounts: every seated wallet in seat order."
      ],
      "discriminator": [
        216,
        52,
        168,
        168,
        53,
        110,
        75,
        132
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "The host (any time in the lobby), or anyone after LOBBY_TIMEOUT_SECS."
          ],
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "run"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createRun",
      "docs": [
        "Base. Creates an empty lobby and its stake vault. The run PDA is pre-funded with rent for",
        "its (public) ephemeral permission, created on the TEE after delegation."
      ],
      "discriminator": [
        195,
        241,
        245,
        139,
        101,
        109,
        209,
        237
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "run",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  117,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "arg",
                "path": "runId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "run"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runId",
          "type": "u64"
        },
        {
          "name": "entryLamports",
          "type": "u64"
        },
        {
          "name": "durationSecs",
          "type": "u32"
        },
        {
          "name": "layout",
          "type": "u8"
        }
      ]
    },
    {
      "name": "delegateBag",
      "docs": [
        "Base. Hands a seat's Bag to the (TEE) ER validator. Sent in the same tx as `join_run`."
      ],
      "discriminator": [
        192,
        37,
        169,
        135,
        248,
        198,
        31,
        34
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "run"
        },
        {
          "name": "bufferBag",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "bag"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                23,
                211,
                148,
                191,
                186,
                102,
                74,
                25,
                65,
                175,
                191,
                130,
                140,
                214,
                93,
                39,
                9,
                169,
                226,
                113,
                133,
                36,
                85,
                234,
                56,
                84,
                145,
                81,
                75,
                175,
                116,
                142
              ]
            }
          }
        },
        {
          "name": "delegationRecordBag",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "bag"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataBag",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "bag"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "bag",
          "writable": true
        },
        {
          "name": "ownerProgram",
          "address": "2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "seat",
          "type": "u8"
        }
      ]
    },
    {
      "name": "delegateRun",
      "docs": [
        "Base. Hands the run to the ER validator (optionally pinned via remaining_accounts[0])."
      ],
      "discriminator": [
        20,
        67,
        38,
        40,
        32,
        211,
        235,
        131
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "bufferRun",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "run"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                23,
                211,
                148,
                191,
                186,
                102,
                74,
                25,
                65,
                175,
                191,
                130,
                140,
                214,
                93,
                39,
                9,
                169,
                226,
                113,
                133,
                36,
                85,
                234,
                56,
                84,
                145,
                81,
                75,
                175,
                116,
                142
              ]
            }
          }
        },
        {
          "name": "delegationRecordRun",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "run"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataRun",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "run"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "run",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  117,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "arg",
                "path": "runId"
              }
            ]
          }
        },
        {
          "name": "ownerProgram",
          "address": "2c1W2MUPCkF6bdcKvKXmLePwBorg6yy8L1A6BdoDBBqw"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "runId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "endRun",
      "docs": [
        "ER. Ends the run and commits + undelegates the run and every Bag to base. Anyone can call it,",
        "but only once the clock has run out or every player is out or dead. Nobody, the host",
        "included, can cut a run short (while exits are locked that would trap everyone).",
        "remaining_accounts: every seat's Bag, in seat order."
      ],
      "discriminator": [
        3,
        68,
        245,
        163,
        207,
        166,
        122,
        189
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "extract",
      "docs": [
        "ER. Finishes a channeled extraction: you leave the dungeon with your bag."
      ],
      "discriminator": [
        39,
        1,
        91,
        107,
        190,
        175,
        160,
        48
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "initBagPermission",
      "docs": [
        "ER. Makes a seat's Bag private: only that seat's session key can read it via the TEE.",
        "Idempotent. Paid from the rent the Bag was pre-funded with at join."
      ],
      "discriminator": [
        180,
        7,
        216,
        20,
        111,
        41,
        203,
        17
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "run"
        },
        {
          "name": "bag",
          "writable": true
        },
        {
          "name": "permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "bag"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "seat",
          "type": "u8"
        }
      ]
    },
    {
      "name": "initRunPermission",
      "docs": [
        "ER. Gives the Run a public permission so every authenticated TEE client can read it.",
        "Idempotent; anyone can call it."
      ],
      "discriminator": [
        166,
        36,
        211,
        108,
        91,
        255,
        221,
        235
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        },
        {
          "name": "permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "run"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "joinRun",
      "docs": [
        "Base. Seats the wallet, takes its stake into the vault, funds + registers the browser",
        "session key, and creates this seat's private Bag (pre-funded for its permission)."
      ],
      "discriminator": [
        72,
        160,
        125,
        102,
        106,
        134,
        246,
        75
      ],
      "accounts": [
        {
          "name": "player",
          "writable": true,
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "run"
              }
            ]
          }
        },
        {
          "name": "session",
          "writable": true
        },
        {
          "name": "bag",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "sessionSigner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "movePlayer",
      "docs": [
        "ER. One grid step. `dir`: 0 up, 1 right, 2 down, 3 left. Stepping onto sacks loots them.",
        "remaining_accounts: every seat's Bag, in seat order."
      ],
      "discriminator": [
        17,
        58,
        68,
        221,
        186,
        117,
        140,
        231
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "dir",
          "type": "u8"
        }
      ]
    },
    {
      "name": "openChest",
      "docs": [
        "ER. Starts opening an adjacent chest; VRF decides the tier in `callback_open_chest`."
      ],
      "discriminator": [
        143,
        8,
        253,
        123,
        197,
        30,
        173,
        15
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        },
        {
          "name": "bag"
        },
        {
          "name": "oracleQueue",
          "writable": true
        },
        {
          "name": "programIdentity",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  100,
                  101,
                  110,
                  116,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "vrfProgram",
          "address": "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "chest",
          "type": "u8"
        }
      ]
    },
    {
      "name": "processUndelegation",
      "discriminator": [
        196,
        28,
        41,
        206,
        48,
        37,
        51,
        167
      ],
      "accounts": [
        {
          "name": "baseAccount",
          "writable": true
        },
        {
          "name": "buffer",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  110,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "baseAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                181,
                183,
                0,
                225,
                242,
                87,
                58,
                192,
                204,
                6,
                34,
                1,
                52,
                74,
                207,
                151,
                184,
                53,
                6,
                235,
                140,
                229,
                25,
                152,
                204,
                98,
                126,
                24,
                147,
                128,
                167,
                62
              ]
            }
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "accountSeeds",
          "type": {
            "vec": "bytes"
          }
        }
      ]
    },
    {
      "name": "settleRun",
      "docs": [
        "Base. Pays out from the vault by the (now public) bag points.",
        "remaining_accounts: every seated wallet in seat order, then every Bag in seat order."
      ],
      "discriminator": [
        131,
        162,
        190,
        83,
        221,
        20,
        93,
        149
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Anyone can trigger settlement."
          ],
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "run"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "startExtract",
      "docs": [
        "ER. Starts channeling an extraction on an exit tile. Exits unlock a quarter of the way into",
        "the run. Moving, attacking or getting hit cancels it; everyone can see you channeling."
      ],
      "discriminator": [
        95,
        24,
        108,
        68,
        98,
        159,
        115,
        130
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "run",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "startRun",
      "docs": [
        "Base. Starts the clock. Sent in the same tx as `delegate_run`."
      ],
      "discriminator": [
        72,
        212,
        1,
        91,
        61,
        186,
        2,
        52
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "run"
          ]
        },
        {
          "name": "run",
          "writable": true
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "bag",
      "discriminator": [
        209,
        73,
        132,
        189,
        4,
        169,
        188,
        103
      ]
    },
    {
      "name": "run",
      "discriminator": [
        199,
        54,
        155,
        86,
        235,
        115,
        246,
        189
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "events": [
    {
      "name": "runSettled",
      "discriminator": [
        11,
        20,
        18,
        58,
        176,
        238,
        55,
        27
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notInLobby",
      "msg": "Run is not in the lobby"
    },
    {
      "code": 6001,
      "name": "notLive",
      "msg": "Run is not live"
    },
    {
      "code": 6002,
      "name": "runFull",
      "msg": "Run is full"
    },
    {
      "code": 6003,
      "name": "alreadyJoined",
      "msg": "Wallet already joined this run"
    },
    {
      "code": 6004,
      "name": "noPlayers",
      "msg": "No players joined"
    },
    {
      "code": 6005,
      "name": "unknownSigner",
      "msg": "Signer is not a session key of any player"
    },
    {
      "code": 6006,
      "name": "dead",
      "msg": "Player is dead"
    },
    {
      "code": 6007,
      "name": "extracted",
      "msg": "Player already extracted"
    },
    {
      "code": 6008,
      "name": "badDirection",
      "msg": "Direction must be 0..=3"
    },
    {
      "code": 6009,
      "name": "blocked",
      "msg": "Tile is blocked"
    },
    {
      "code": 6010,
      "name": "noTarget",
      "msg": "No player on that tile"
    },
    {
      "code": 6011,
      "name": "badChest",
      "msg": "Unknown chest"
    },
    {
      "code": 6012,
      "name": "chestUnavailable",
      "msg": "Chest already opened or opening"
    },
    {
      "code": 6013,
      "name": "notAdjacent",
      "msg": "Chest is not adjacent"
    },
    {
      "code": 6014,
      "name": "notOnExtract",
      "msg": "Not standing on an extraction tile"
    },
    {
      "code": 6015,
      "name": "timeUp",
      "msg": "The run timer has run out"
    },
    {
      "code": 6016,
      "name": "cannotEndYet",
      "msg": "Run can't be ended yet"
    },
    {
      "code": 6017,
      "name": "notEnded",
      "msg": "Run has not ended"
    },
    {
      "code": 6018,
      "name": "alreadySettled",
      "msg": "Run already settled"
    },
    {
      "code": 6019,
      "name": "walletMismatch",
      "msg": "Wallet accounts don't match the seats"
    },
    {
      "code": 6020,
      "name": "badDuration",
      "msg": "Duration must be positive"
    },
    {
      "code": 6021,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6022,
      "name": "attackCooldown",
      "msg": "Attack is on cooldown"
    },
    {
      "code": 6023,
      "name": "badSeat",
      "msg": "Unknown seat"
    },
    {
      "code": 6024,
      "name": "badBag",
      "msg": "Bag accounts don't match the seats"
    },
    {
      "code": 6025,
      "name": "exitsLocked",
      "msg": "Exits are still locked"
    },
    {
      "code": 6026,
      "name": "notChanneling",
      "msg": "Not extracting: stand on an exit and start extracting first"
    },
    {
      "code": 6027,
      "name": "stillChanneling",
      "msg": "Still extracting: hold still a moment longer"
    },
    {
      "code": 6028,
      "name": "cannotCancelYet",
      "msg": "Only the host can cancel this lobby yet"
    }
  ],
  "types": [
    {
      "name": "bag",
      "docs": [
        "One player's loot. Delegated to the TEE rollup with a permission that only that player's",
        "session key can read, so opponents can't see what anyone is carrying until the run ends."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "run",
            "type": "pubkey"
          },
          {
            "name": "seat",
            "type": "u8"
          },
          {
            "name": "points",
            "docs": [
              "Points carried."
            ],
            "type": "u16"
          },
          {
            "name": "dropped",
            "docs": [
              "Points in this player's sack on the floor (after death), until someone picks it up."
            ],
            "type": "u16"
          },
          {
            "name": "lastTier",
            "docs": [
              "Tier of the last chest this player opened (so only they see what they got)."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "chest",
      "docs": [
        "Public chest state. The rolled tier is private: it is written into the opener's `Bag`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "state",
            "type": "u8"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "opener",
            "docs": [
              "Seat index of the player who opened it."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "droppedBag",
      "docs": [
        "Where a dead player's sack lies. What's inside is private (the victim's `Bag.dropped`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "x",
            "type": "u8"
          },
          {
            "name": "y",
            "type": "u8"
          },
          {
            "name": "points",
            "type": "u16"
          },
          {
            "name": "present",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "playerSlot",
      "docs": [
        "Public per-player state, readable by everyone. Loot lives in the private `Bag`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "docs": [
              "Wallet that staked and receives payouts."
            ],
            "type": "pubkey"
          },
          {
            "name": "signer",
            "docs": [
              "Browser session key allowed to act for this player inside the ER."
            ],
            "type": "pubkey"
          },
          {
            "name": "x",
            "type": "u8"
          },
          {
            "name": "y",
            "type": "u8"
          },
          {
            "name": "hp",
            "type": "u8"
          },
          {
            "name": "alive",
            "type": "bool"
          },
          {
            "name": "extracted",
            "type": "bool"
          },
          {
            "name": "kills",
            "type": "u8"
          },
          {
            "name": "lastAttackSlot",
            "docs": [
              "ER slot of this player's last attack (cooldown)."
            ],
            "type": "u64"
          },
          {
            "name": "extractStartSlot",
            "docs": [
              "ER slot this player started channeling an extraction, or 0 if not channeling."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "run",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "runId",
            "type": "u64"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "playerCount",
            "type": "u8"
          },
          {
            "name": "entryLamports",
            "type": "u64"
          },
          {
            "name": "pot",
            "docs": [
              "Total stakes held in the vault."
            ],
            "type": "u64"
          },
          {
            "name": "durationSecs",
            "type": "u32"
          },
          {
            "name": "endsAt",
            "type": "i64"
          },
          {
            "name": "players",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "playerSlot"
                  }
                },
                4
              ]
            }
          },
          {
            "name": "chests",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "chest"
                  }
                },
                11
              ]
            }
          },
          {
            "name": "dropped",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "droppedBag"
                  }
                },
                4
              ]
            }
          },
          {
            "name": "settled",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "layout",
            "docs": [
              "Which of `map::MAPS` this run is played on (picked by the client at creation)."
            ],
            "type": "u8"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix time the run was created; lobbies that never start can be cancelled after a timeout."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "runSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "run",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": {
              "array": [
                "u64",
                4
              ]
            }
          },
          {
            "name": "points",
            "type": {
              "array": [
                "u16",
                4
              ]
            }
          }
        ]
      }
    },
    {
      "name": "vault",
      "docs": [
        "Holds the stakes on the base layer. Never delegated, so payouts can't be touched by the ER."
      ],
      "type": {
        "kind": "struct",
        "fields": []
      }
    }
  ]
};
