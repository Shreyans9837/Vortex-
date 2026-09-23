pragma circom 2.1.6;

template VortexMultiply() {
    signal input a;
    signal input b;
    signal output c;
    c <== a * b;
}

component main = VortexMultiply();
