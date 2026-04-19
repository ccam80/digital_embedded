/*
 * Standalone driver replicating the GEAR corrector body from
 * ref/ngspice/src/maths/ni/nicomcof.c (lines 53-117).
 *
 * Compile: gcc -std=c99 -O0 -ffloat-store -o gear-nicomcof-driver gear-nicomcof-driver.c
 * Run:     ./gear-nicomcof-driver
 *
 * This file is a research artifact — do not edit project source with it.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#define GEAR 2

typedef struct {
    int    CKTintegrateMethod;
    int    CKTorder;
    double CKTdelta;
    double CKTdeltaOld[7];
    double CKTag[7];
} CKTcircuit;

/* bzero shim */
static void my_bzero(void *p, size_t n) { memset(p, 0, n); }
#define bzero my_bzero

static void NIcomCof_GEAR(CKTcircuit *ckt) {
    double mat[8][8];
    int i, j, k;
    double arg, arg1;

    bzero(ckt->CKTag, 7 * sizeof(double));
    ckt->CKTag[1] = -1.0 / ckt->CKTdelta;

    /* set up matrix */
    arg = 0;
    for (i = 0; i <= ckt->CKTorder; i++) { mat[0][i] = 1; }
    for (i = 1; i <= ckt->CKTorder; i++) { mat[i][0] = 0; }

    for (i = 1; i <= ckt->CKTorder; i++) {
        arg += ckt->CKTdeltaOld[i - 1];
        arg1 = 1;
        for (j = 1; j <= ckt->CKTorder; j++) {
            arg1 *= arg / ckt->CKTdelta;
            mat[j][i] = arg1;
        }
    }

    /* LU decompose (starts at 1 — special case) */
    for (i = 1; i <= ckt->CKTorder; i++) {
        for (j = i + 1; j <= ckt->CKTorder; j++) {
            mat[j][i] /= mat[i][i];
            for (k = i + 1; k <= ckt->CKTorder; k++) {
                mat[j][k] -= mat[j][i] * mat[i][k];
            }
        }
    }

    /* forward substitution (starts at 1) */
    for (i = 1; i <= ckt->CKTorder; i++) {
        for (j = i + 1; j <= ckt->CKTorder; j++) {
            ckt->CKTag[j] = ckt->CKTag[j] - mat[j][i] * ckt->CKTag[i];
        }
    }

    /* backward substitution */
    ckt->CKTag[ckt->CKTorder] /= mat[ckt->CKTorder][ckt->CKTorder];
    for (i = ckt->CKTorder - 1; i >= 0; i--) {
        for (j = i + 1; j <= ckt->CKTorder; j++) {
            ckt->CKTag[i] = ckt->CKTag[i] - mat[i][j] * ckt->CKTag[j];
        }
        ckt->CKTag[i] /= mat[i][i];
    }
}

static uint64_t dbl_bits(double x) {
    uint64_t u;
    memcpy(&u, &x, 8);
    return u;
}

int main(void) {
    int orders[] = {4, 5, 6};
    int n;

    /* Closed-form rational values */
    double cf4 = (25.0 / 12.0) / 1e-6;
    double cf5 = (137.0 / 60.0) / 1e-6;
    double cf6 = (49.0 / 20.0) / 1e-6;
    printf("Closed-form rationals:\n");
    printf("  order4: %.17g  hex: 0x%016llx\n", cf4, (unsigned long long)dbl_bits(cf4));
    printf("  order5: %.17g  hex: 0x%016llx\n", cf5, (unsigned long long)dbl_bits(cf5));
    printf("  order6: %.17g  hex: 0x%016llx\n\n", cf6, (unsigned long long)dbl_bits(cf6));

    for (n = 0; n < 3; n++) {
        CKTcircuit ckt;
        int ord = orders[n];
        int ii;
        ckt.CKTintegrateMethod = GEAR;
        ckt.CKTorder = ord;
        ckt.CKTdelta = 1e-6;
        for (ii = 0; ii < 7; ii++) ckt.CKTdeltaOld[ii] = 1e-6;

        NIcomCof_GEAR(&ckt);

        printf("GEAR order %d:\n", ord);
        for (ii = 0; ii <= ord; ii++) {
            printf("  CKTag[%d] = %.17g  hex: 0x%016llx\n",
                   ii, ckt.CKTag[ii], (unsigned long long)dbl_bits(ckt.CKTag[ii]));
        }
        printf("\n");
    }
    return 0;
}
